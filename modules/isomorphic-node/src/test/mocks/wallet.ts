import { fake } from "sinon";

import { IWalletService } from "../../core/shared/wallet/wallet.service";

export const mockWalletService: IWalletService = {
  getPublicIdentifier: fake(() => {
    return;
  }),
  getSignerAddress: fake(() => {
    return;
  }),
  getChannel: fake(() => {
    return;
  }),
  setup: fake(() => {
    return;
  }),
  create: fake(() => {
    return;
  }),
  deposit: fake(() => {
    return;
  }),
  withdraw: fake(() => {
    return;
  }),
  resolve: fake(() => {
    return;
  }),
};
