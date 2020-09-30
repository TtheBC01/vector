import {
  ConditionalTransferCreatedPayload,
  ConditionalTransferResolvedPayload,
  Result,
  ServerNodeResponses,
  Values,
  VectorError,
  RouterSchemas,
  ServerNodeParams,
} from "@connext/vector-types";
import { BaseLogger } from "pino";
import { BigNumber } from "ethers";
import { IServerNodeService, ServerNodeError } from "@connext/vector-utils";

import { getSwappedAmount } from "./services/swap";
import { getRebalanceProfile } from "./services/rebalance";
import { IRouterStore } from "./services/store";

export class ForwardTransferError extends VectorError {
  readonly type = VectorError.errors.RouterError;

  static readonly reasons = {
    SenderChannelNotFound: "Sender channel not found",
    RecipientChannelNotFound: "Recipient channel not found",
    UnableToCalculateSwap: "Could not calculate swap",
    UnableToGetRebalanceProfile: "Could not get rebalance profile",
    ErrorForwardingTransfer: "Error forwarding transfer",
    UnableToCollateralize: "Could not collateralize receiver channel",
  } as const;

  constructor(
    public readonly message: Values<typeof ForwardTransferError.reasons>,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public readonly context?: any,
  ) {
    super(message, context);
  }
}

export class ForwardResolutionError extends VectorError {
  readonly type = VectorError.errors.RouterError;

  static readonly reasons = {
    IncomingChannelNotFound: "Incoming channel for transfer not found",
    ErrorResolvingTransfer: "Error resolving tranfer",
  } as const;

  constructor(
    public readonly message: Values<typeof ForwardResolutionError.reasons>,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public readonly context?: any,
  ) {
    super(message, context);
  }
}

export async function forwardTransferCreation(
  data: ConditionalTransferCreatedPayload,
  node: IServerNodeService,
  store: IRouterStore,
  logger: BaseLogger,
): Promise<Result<any, ForwardTransferError>> {
  const method = "forwardTransferCreation";
  logger.info(
    { data, method, node: { signerAddress: node.signerAddress, publicIdentifier: node.publicIdentifier } },
    "Received transfer event, starting forwarding",
  );

  /*
  A note on the transfer event data and conditionalTransfer() params:

  In Indra, we have business logic bleed into several different parts of the stack. This means that adding support for new transfers
  involves making changes to several different places to add support for new params and event types.

  Ideally, all of these changes should now be isolated to the engine. The challenge with this is that consumers of the engine interface
  (or server-node interface) need to pass in the correct params for a given transfer. This means that in the router, we'd need to
  retain context into a conditional transfer type to correctly call the node conditionalTransfer() fn.

  We specifically don't want the router to operate this way. Given this, the best approach I can think of is to structure event/param objects
  for conditional transfer as follows:
  1. Have named fields for all of the data that would actually be needed by the router. This would be: `amount`, `assetId`, `recipientChainId`,
      `recipient`, `recipientAssetId`, `requireOnline`.
  2. Put all other params (basically everything related to the specifics of the condition: `type`, `lockHash`, etc.) into an opaque object
      that the router just catches from the transfer event and passes directly to the server-node.

  Because we're validating the actual conditional params + allowed transfer definitions at the lower levels, this feels safe to do.
  */

  const {
    transfer: {
      initialBalance: {
        amount: [senderAmount],
      },
      assetId: senderAssetId,
      meta: untypedMeta,
      transferState: conditionData,
      channelAddress: senderChannelAddress,
      initiator,
    },
    conditionType,
  } = data;
  const meta = { ...untypedMeta } as RouterSchemas.RouterMeta & any;
  const { routingId } = meta;
  const [path] = meta.path;

  const recipientIdentifier = path.recipient;
  if (!recipientIdentifier || recipientIdentifier === node.publicIdentifier) {
    logger.warn({ path, method }, "No path to follow");
    return Result.ok(undefined);
  }

  if (initiator === node.signerAddress) {
    logger.warn({ initiator, method }, "Initiated by our node, doing nothing");
    return Result.ok(undefined);
  }

  // TODO validate the above params

  const senderChannelRes = await node.getStateChannel(senderChannelAddress);
  if (senderChannelRes.isError) {
    return Result.fail(
      new ForwardTransferError(
        ForwardTransferError.reasons.SenderChannelNotFound,
        senderChannelRes.getError()?.message,
      ),
    );
  }
  const senderChannel = senderChannelRes.getValue();
  if (!senderChannel) {
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.SenderChannelNotFound, {
        channelAddress: senderChannelAddress,
      }),
    );
  }
  const senderChainId = senderChannel.networkContext.chainId;

  // Defaults
  const recipientAssetId = path.recipientAssetId ? path.recipientAssetId : senderAssetId;
  const requireOnline = meta.requireOnline ?? false;
  const recipientChainId = path.recipientChainId ? path.recipientChainId : senderChainId;

  // Below, we figure out the correct params needed for the receiver's channel. This includes
  // potential swaps/crosschain stuff
  let recipientAmount = senderAmount;
  if (recipientAssetId !== senderAssetId) {
    logger.warn({ method, recipientAssetId, senderAssetId, recipientChainId }, "Detected inflight swap");
    const swapRes = await getSwappedAmount(
      senderAmount,
      senderAssetId,
      senderChainId,
      recipientAssetId,
      recipientChainId,
    );
    if (swapRes.isError) {
      return Result.fail(
        new ForwardTransferError(ForwardTransferError.reasons.UnableToCalculateSwap, {
          message: swapRes.getError()?.message,
        }),
      );
    }
    recipientAmount = swapRes.getValue();
    logger.warn({ method, recipientAssetId, recipientAmount, recipientChainId }, "Inflight swap calculated");
  }

  // Next, get the recipient's channel and figure out whether it needs to be collateralized
  const recipientChannelRes = await node.getStateChannelByParticipants(
    node.publicIdentifier,
    recipientIdentifier,
    recipientChainId,
  );
  if (recipientChannelRes.isError) {
    return Result.fail(
      new ForwardTransferError(
        ForwardTransferError.reasons.RecipientChannelNotFound,
        recipientChannelRes.getError()?.message,
      ),
    );
  }
  const recipientChannel = recipientChannelRes.getValue();
  if (!recipientChannel) {
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.RecipientChannelNotFound, {
        participants: [node.publicIdentifier, recipientIdentifier],
        chainId: recipientChainId,
      }),
    );
  }

  // TODO use a provider or service pattern here so we can unit test
  const profileRes = await getRebalanceProfile(recipientChannel.channelAddress, recipientAssetId);
  if (profileRes.isError) {
    return Result.fail(profileRes.getError()!);
  }

  const profile = profileRes.getValue();

  // Figure out router balance
  const assetIdx = recipientChannel.assetIds.findIndex((a: string) => a === recipientAssetId);
  const routerBalanceInRecipientChannel =
    assetIdx === -1
      ? "0"
      : node.signerAddress == recipientChannel.alice
      ? recipientChannel.balances[assetIdx].amount[0]
      : recipientChannel.balances[assetIdx].amount[1];

  // If there are not enough funds, fall back to sending the entire transfer amount + required collateral amount
  if (BigNumber.from(routerBalanceInRecipientChannel).lt(recipientAmount)) {
    logger.info(
      { method, routerBalanceInRecipientChannel, recipientAmount },
      "Just-in-time collateralization required",
    );
    // This means we need to collateralize this tx in-flight. To avoid having to rebalance twice, we should collateralize
    // the `amount` plus the `profile.target`

    const depositRes = await node.deposit(
      {
        channelAddress: recipientChannel.channelAddress,
        assetId: recipientAssetId,
        amount: BigNumber.from(recipientAmount)
          .add(profile.target)
          .toString(),
      },
      recipientChainId,
    );
    if (depositRes.isError) {
      return Result.fail(
        new ForwardTransferError(ForwardTransferError.reasons.UnableToCollateralize, {
          message: depositRes.getError()?.message,
          context: depositRes.getError()?.context,
        }),
      );
    }
    // TODO we'll need to check for a failed deposit here too.

    // TODO what do we do here about concurrent deposits? Do we want to set a lock?
    // Ideally, we should add to the core contracts to do one of two things:
    // 1. Allow for multiple deposits to be stored by Alice onchain in the mapping.
    //  --> note that this means the dispute + utils code now needs to account for these too
    // 2. Allow for passing in the nonce to the depositA function. This way, if a deposit gets
    //    stuck, it's possible to "cancel and overwrite" it by sending another tx at the same
    //    nonce. Only one of the two txs will succeed.
  }

  // If the above is not the case, we can make the transfer!
  const transfer = await node.conditionalTransfer({
    amount: recipientAmount,
    assetId: recipientAssetId,
    channelAddress: recipientChannel.channelAddress,
    details: conditionData,
    meta: {
      // Node is never the initiator, that is always payment sender
      senderIdentifier:
        initiator === senderChannel.bobIdentifier ? senderChannel.bobIdentifier : senderChannel.aliceIdentifier,
      ...meta,
    },
    conditionType,
  });
  if (transfer.isError) {
    if (!requireOnline && transfer.getError()?.message === ServerNodeError.reasons.Timeout) {
      // store transfer
      const type = "TransferCreation";
      await store.queueUpdate(type, {
        channelAddress: recipientChannel.channelAddress,
        amount: recipientAmount,
        assetId: recipientAssetId,
        routingId,
        conditionData,
      });
    }
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.ErrorForwardingTransfer, {
        message: transfer.getError()?.message,
      }),
    );
  }

  return Result.ok(transfer.getValue());
}

export async function forwardTransferResolution(
  data: ConditionalTransferResolvedPayload,
  node: IServerNodeService,
  store: IRouterStore,
  logger: BaseLogger,
): Promise<Result<undefined | ServerNodeResponses.ResolveTransfer, ForwardResolutionError>> {
  const method = "forwardTransferResolution";
  logger.info(
    { data, method, node: { signerAddress: node.signerAddress, publicIdentifier: node.publicIdentifier } },
    "Received transfer resolution, starting forwarding",
  );
  const {
    channelAddress,
    transfer: { transferId, responder, transferResolver, meta },
    conditionType,
  } = data;
  const { routingId } = meta as RouterSchemas.RouterMeta;

  // If there is no resolver, do nothing
  if (!transferResolver) {
    logger.warn({ transferId, routingId, channelAddress }, "No resolver found in transfer");
    return Result.ok(undefined);
  }

  // If we are the receiver of this transfer, do nothing
  if (responder === node.signerAddress) {
    logger.info({ method, routingId }, "Nothing to reclaim");
    return Result.ok(undefined);
  }

  // Find the channel with the corresponding transfer to unlock
  const transfersRes = await node.getTransfersByRoutingId(routingId);
  if (transfersRes.isError) {
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.IncomingChannelNotFound, {
        routingId,
        error: transfersRes.getError()?.message,
      }),
    );
  }

  // find transfer where node is responder
  const incomingTransfer = transfersRes.getValue().find(transfer => transfer.responder === node.signerAddress);

  if (!incomingTransfer) {
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.IncomingChannelNotFound, {
        routingId,
      }),
    );
  }

  // Resolve the sender transfer
  const resolveParams: ServerNodeParams.ResolveTransfer = {
    channelAddress: incomingTransfer.channelAddress,
    transferId: incomingTransfer.transferId,
    meta: {},
    conditionType,
    details: { ...transferResolver },
  };
  const resolution = await node.resolveTransfer(resolveParams);
  if (resolution.isError) {
    // Store the transfer, retry later
    // TODO: add logic to periodically retry resolving transfers
    const type = "TransferResolution";
    await store.queueUpdate(type, resolveParams);
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.ErrorResolvingTransfer, {
        message: resolution.getError()?.message,
        routingId,
        transferResolver,
        incomingTransferChannel: incomingTransfer.channelAddress,
        recipientTransferId: transferId,
        recipientChannelAddress: channelAddress,
      }),
    );
  }

  return Result.ok(resolution.getValue());
}

export async function handleIsAlive(data: any, node: IServerNodeService, store: IRouterStore) {
  // This means the user is online and has checked in. Get all updates that are queued and then execute them.
  // const updates = await store.getQueuedUpdates(data.channelAdress);
  // updates.forEach(async update => {
  //   if (update.type == "TransferCreation") {
  //     const { channelAddress, amount, assetId, paymentId, conditionData } = update.data;
  //     // TODO do we want to try catch this? What should happen if this fails?
  //     await node.conditionalTransfer(channelAddress, amount, assetId, paymentId, conditionData);
  //   } else if (update.type == "TransferResolution") {
  //     const { channelAddress, paymentId, resolverData } = update.data;
  //     // TODO same as above
  //     await node.resolveCondtion(channelAddress, paymentId, resolverData);
  //   }
  // });
}