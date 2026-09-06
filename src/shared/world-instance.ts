/** Public identity of one saved execution, independent of seed, rules or browser.
 * This is not a credential and grants no access to the world. */
export interface WorldInstanceView { instanceId?: string; tick: number; }
export function validWorldInstanceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
