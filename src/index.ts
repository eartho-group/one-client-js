import 'core-js/es/string/starts-with';
import 'core-js/es/symbol';
import 'core-js/es/array/from';
import 'core-js/es/typed-array/slice';
import 'core-js/es/array/includes';
import 'core-js/es/string/includes';
import 'core-js/es/set';
import 'promise-polyfill/src/polyfill';
import 'fast-text-encoding';
import 'abortcontroller-polyfill/dist/abortcontroller-polyfill-only';

import EarthoOne from './EarthoOne';
import { EarthoOneOptions } from './global';

import './global';

export * from './global';

/**
 * Asynchronously creates the earthoOne instance and calls `checkSession`.
 *
 * **Note:** There are caveats to using this in a private browser tab, which may not silently authenticae
 * a user on page refresh. Please see [the checkSession docs]EarthoOne for more info.
 *
 * @param options The client options
 * @returns An instance of EarthoOne
 */
export default async function createEarthoOne(options: EarthoOneOptions) {
  const earthoOne =  new EarthoOne(options);
  await earthoOne.checkSession();
  return earthoOne;
}

export { EarthoOne };

export {
  GenericError,
  AuthenticationError,
  TimeoutError,
  PopupTimeoutError,
  PopupCancelledError,
  MfaRequiredError
} from './errors';

export { ICache, LocalStorageCache, InMemoryCache, Cacheable } from './core/cache';
