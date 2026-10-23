/**
 * Per-call budget of an API adapter (jobs KTD8): a job's `maxBudgetUsd`
 * becomes a `maxTokens` ceiling through the list prices in
 * `data/prices.json`. A call whose input alone costs more than the budget is
 * refused before it is sent.
 *
 * The input is estimated at 4 characters per token; the cost uses list
 * prices, not the caller's negotiated rate, so the ceiling is an estimate.
 */

import { priceForModel } from "../routing.js";
import { conversation, NonRetryableError, type DispatchOptions } from "./base.js";

/** Above this many output tokens the ceiling is not sent: the model's own limit applies. */
const OPEN_CEILING_TOKENS = 32_000;

/** The call's input alone costs more than its budget. */
export class BudgetExceededError extends NonRetryableError {
  constructor(model: string, inputUsd: number, budgetUsd: number) {
    super(
      `stopped: budget ${budgetUsd} USD is below the input cost of about ${inputUsd.toFixed(4)} USD for ${model}; not sent`,
      { stopped_by: "budget" },
    );
    this.name = "BudgetExceededError";
  }
}

/** Models with no price that already logged their one line. */
const unpriced = new Set<string>();

/**
 * The `maxTokens` to send. Without `options.maxBudgetUsd`: `options.maxTokens`
 * as given. With it: the smaller of `options.maxTokens` (else `adapterDefault`)
 * and what the budget leaves after the input; a ceiling above
 * {@link OPEN_CEILING_TOKENS} with no explicit or default value is not sent.
 * A model missing from the price table keeps the adapter default and logs
 * one line. Throws {@link BudgetExceededError} when the input alone costs
 * more than the budget.
 */
export function budgetMaxTokens(
  model: string,
  prompt: string,
  options: DispatchOptions,
  adapterDefault?: number,
): number | undefined {
  const budget = options.maxBudgetUsd;
  if (budget === undefined || !(budget > 0)) return options.maxTokens;
  const price = priceForModel(model);
  if (!price) {
    if (!unpriced.has(model)) {
      unpriced.add(model);
      // eslint-disable-next-line no-console
      console.warn(`[tidegap] no price for ${model} in data/prices.json; its budget cap is not applied`);
    }
    return options.maxTokens;
  }
  const chars = [options.system ?? "", ...conversation(prompt, options).map((m) => m.content)].join("").length;
  const inputUsd = (Math.ceil(chars / 4) / 1_000_000) * price.inUsdPerMtok;
  if (inputUsd >= budget) throw new BudgetExceededError(model, inputUsd, budget);
  if (!(price.outUsdPerMtok > 0)) return options.maxTokens;
  const allowed = Math.max(1, Math.floor(((budget - inputUsd) / price.outUsdPerMtok) * 1_000_000));
  const wanted = options.maxTokens ?? adapterDefault;
  if (wanted !== undefined) return Math.min(wanted, allowed);
  return allowed <= OPEN_CEILING_TOKENS ? allowed : undefined;
}
