import { types } from 'node:util';
import { createCooperationMembershipBoundary, createCooperationMembershipContext } from '../world/cooperation-membership.js';

// Loaded by the stock Node host before World callbacks; never imported by world/client.
export const nodeCooperationMembershipBoundary = createCooperationMembershipBoundary(types.isProxy);
export const nodeCooperationMembershipContext = <T extends object>(context: T) =>
  createCooperationMembershipContext(context, nodeCooperationMembershipBoundary);
