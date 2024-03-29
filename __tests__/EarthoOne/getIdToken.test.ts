import { verify } from '../../src/jwt';
import { MessageChannel } from 'worker_threads';
import * as utils from '../../src/utils';
import * as scope from '../../src/scope';
import { expect } from '@jest/globals';

// @ts-ignore

import { connectWithPopupFn, connectWithRedirectFn, setupFn } from './helpers';

import { TEST_CODE_CHALLENGE } from '../constants';

jest.mock('es-cookie');
jest.mock('../../src/jwt');
jest.mock('../../src/worker/token.worker');

const mockWindow = <any>global;
const mockFetch = <jest.Mock>mockWindow.fetch;
const mockVerify = <jest.Mock>verify;

jest
  .spyOn(utils, 'bufferToBase64UrlEncoded')
  .mockReturnValue(TEST_CODE_CHALLENGE);

jest.spyOn(utils, 'runPopup');

const setup = setupFn(mockVerify);
const connectWithRedirect = connectWithRedirectFn(mockWindow, mockFetch);
const connectWithPopup = connectWithPopupFn(mockWindow, mockFetch);

describe('EarthoOne', () => {
  const oldWindowLocation = window.location;

  beforeEach(() => {
    // https://www.benmvp.com/blog/mocking-window-location-methods-jest-jsdom/
    delete window.location;
    window.location = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(oldWindowLocation),
        assign: {
          configurable: true,
          value: jest.fn()
        }
      }
    ) as Location;
    // --

    mockWindow.open = jest.fn();
    mockWindow.addEventListener = jest.fn();
    mockWindow.crypto = {
      subtle: {
        digest: () => 'foo'
      },
      getRandomValues() {
        return '123';
      }
    };
    mockWindow.MessageChannel = MessageChannel;
    mockWindow.Worker = {};
    jest.spyOn(scope, 'getUniqueScopes');
    sessionStorage.clear();
  });

  afterEach(() => {
    mockFetch.mockReset();
    jest.clearAllMocks();
    window.location = oldWindowLocation;
  });

  describe('getIdToken', () => {
    it('returns undefined if there is no cache', async () => {
      const eartho = setup();
      const decodedToken = await eartho.getIdToken();

      expect(decodedToken).toBeUndefined();
    });

    // The getIdToken is dependent on the result of a successful or failed login.
    // As the SDK allows for a user to login using a redirect or a popup approach,
    // functionality has to be guaranteed to be working in both situations.

    // To avoid excessive test duplication, tests are being generated twice.
    //  - once for connectWithRedirect
    //  - once for connectWithPopup
    [
      {
        name: 'connectWithRedirect',
        login: connectWithRedirect
      },
      {
        name: 'connectWithPopup',
        login: connectWithPopup
      }
    ].forEach(
      ({
        name,
        login
      }: {
        name: string;
        login: typeof connectWithRedirect | typeof connectWithPopup;
      }) => {
        describe(`when ${name}`, () => {
          it('returns the ID token claims', async () => {
            const eartho = setup({ authorizationParams: { scope: 'foo' } });
            await login(eartho);

            expect(await eartho.getIdToken()).toHaveProperty('exp');
            expect(await eartho.getIdToken()).not.toHaveProperty('me');
          });

          it('returns the ID token claims with custom scope', async () => {
            const eartho = setup({
              authorizationParams: {
                scope: 'scope1 scope2'
              }
            });
            await login(eartho, { authorizationParams: { scope: 'scope3' } });

            expect(await eartho.getIdToken()).toHaveProperty('exp');
          });

          describe('when using refresh tokens', () => {
            it('returns the ID token claims with offline_access', async () => {
              const eartho = setup({
                authorizationParams: { scope: 'foo' },
                useRefreshTokens: true
              });
              await login(eartho);

              expect(await eartho.getIdToken()).toHaveProperty('exp');
            });

            it('returns the ID token claims with custom scope and offline_access', async () => {
              const eartho = setup({
                authorizationParams: {
                  scope: 'scope1 scope2'
                },
                useRefreshTokens: true
              });
              await login(eartho, { authorizationParams: { scope: 'scope3' } });

              expect(await eartho.getIdToken()).toHaveProperty('exp');
            });
          });
        });
      }
    );
  });
});
