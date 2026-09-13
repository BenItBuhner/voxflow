/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as appRules from "../appRules.js";
import type * as billing from "../billing.js";
import type * as devices from "../devices.js";
import type * as dictionary from "../dictionary.js";
import type * as entitlements from "../entitlements.js";
import type * as gateway from "../gateway.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as inference from "../inference.js";
import type * as lib_clerkWebhook from "../lib/clerkWebhook.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_inference from "../lib/inference.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_streak from "../lib/streak.js";
import type * as lib_stripe from "../lib/stripe.js";
import type * as lib_users from "../lib/users.js";
import type * as lib_validators from "../lib/validators.js";
import type * as preferences from "../preferences.js";
import type * as snippets from "../snippets.js";
import type * as stats from "../stats.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  appRules: typeof appRules;
  billing: typeof billing;
  devices: typeof devices;
  dictionary: typeof dictionary;
  entitlements: typeof entitlements;
  gateway: typeof gateway;
  history: typeof history;
  http: typeof http;
  inference: typeof inference;
  "lib/clerkWebhook": typeof lib_clerkWebhook;
  "lib/entitlements": typeof lib_entitlements;
  "lib/functions": typeof lib_functions;
  "lib/inference": typeof lib_inference;
  "lib/limits": typeof lib_limits;
  "lib/normalize": typeof lib_normalize;
  "lib/plans": typeof lib_plans;
  "lib/streak": typeof lib_streak;
  "lib/stripe": typeof lib_stripe;
  "lib/users": typeof lib_users;
  "lib/validators": typeof lib_validators;
  preferences: typeof preferences;
  snippets: typeof snippets;
  stats: typeof stats;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
