import Lock from 'browser-tabs-lock';

import {
    createQueryParams,
    runPopup,
    parseQueryResult,
    encode,
    createRandomString,
    runIframe,
    sha256,
    bufferToBase64UrlEncoded,
    validateCrypto,
    openPopup
} from './utils';

import { oauthToken } from './core/api';

import { getUniqueScopes } from './support/scope';

import {
    InMemoryCache,
    ICache,
    LocalStorageCache,
    CacheKey,
    CacheManager
} from './core/cache';

import TransactionManager from './core/transaction-manager';
import { verify as verifyIdToken } from './support/jwt';
import { AuthenticationError, GenericError, TimeoutError } from './errors';

import {
    ClientStorage,
    CookieStorage,
    CookieStorageWithLegacySameSite,
    SessionStorage
} from './core/storage';

import {
    CACHE_LOCATION_MEMORY,
    DEFAULT_POPUP_CONFIG_OPTIONS,
    DEFAULT_AUTHORIZE_TIMEOUT_IN_SECONDS,
    MISSING_REFRESH_TOKEN_ERROR_MESSAGE,
    DEFAULT_SCOPE,
    RECOVERABLE_ERRORS,
    DEFAULT_SESSION_CHECK_EXPIRY_DAYS,
    DEFAULT_EARTHO_CLIENT,
    INVALID_REFRESH_TOKEN_ERROR_MESSAGE,
    DEFAULT_NOW_PROVIDER,
    DEFAULT_FETCH_TIMEOUT_MS
} from './constants';

import {
    EarthoOneOptions,
    BaseLoginOptions,
    AuthorizeOptions,
    RedirectConnectOptions,
    PopupConnectOptions,
    PopupConfigOptions,
    GetUserOptions,
    GetIdTokenClaimsOptions,
    RedirectLoginResult,
    GetTokenSilentlyOptions,
    GetTokenWithPopupOptions,
    LogoutOptions,
    RefreshTokenOptions,
    OAuthTokenOptions,
    CacheLocation,
    LogoutUrlOptions,
    User,
    IdToken,
    GetTokenSilentlyVerboseResponse,
    TokenEndpointResponse
} from './global';

// @ts-ignore
import TokenWorker from './core/worker/token.worker.ts';
import { isIE11 } from './support/user-agent';
import { singlePromise, retryPromise } from './support/promise-utils';
import { CacheKeyManifest } from './core/cache/key-manifest';

/**
 * @ignore
 */
type GetTokenSilentlyResult = TokenEndpointResponse & {
    decodedToken: ReturnType<typeof verifyIdToken>;
    scope: string;
    oauthTokenScope?: string;
    audience: string;
};

/**
 * @ignore
 */
const lock = new Lock();

/**
 * @ignore
 */
const GET_TOKEN_SILENTLY_LOCK_KEY = 'earthoOne.lock.getTokenSilently';

/**
 * @ignore
 */
const OLD_IS_AUTHENTICATED_COOKIE_NAME = 'earthoOne.is.authenticated';

/**
 * @ignore
 */
const buildisConnectedCookieName = (clientId: string) =>
    `earthoOne.${clientId}.is.authenticated`;

/**
 * @ignore
 */
const cacheLocationBuilders: Record<string, () => ICache> = {
    memory: () => new InMemoryCache().enclosedCache,
    localstorage: () => new LocalStorageCache()
};

/**
 * @ignore
 */
const cacheFactory = (location: string) => {
    return cacheLocationBuilders[location];
};

/**
 * @ignore
 */
const supportWebWorker = () => !isIE11();

/**
 * @ignore
 */
const getTokenIssuer = (issuer: string, domainUrl: string) => {
    if (issuer) {
        return issuer.startsWith('https://') ? issuer : `https://${issuer}/`;
    }

    return `${domainUrl}/`;
};

/**
 * @ignore
 */
const getDomain = (domainUrl: string) => {
    if (!/^https?:\/\//.test(domainUrl)) {
        return `https://${domainUrl}`;
    }

    return domainUrl;
};

/**
 * @ignore
 */
const getCustomInitialOptions = (
    options: EarthoOneOptions
): BaseLoginOptions => {
    const {
        advancedOptions,
        audience,
        earthoOne,
        authorizeTimeoutInSeconds,
        cacheLocation,
        client_id,
        domain,
        issuer,
        leeway,
        max_age,
        redirect_uri,
        scope,
        useRefreshTokens,
        useCookiesForTransactions,
        useFormData,
        ...customParams
    } = options;
    return customParams;
};

/**
 */
export default class EarthoOne {
    private readonly transactionManager: TransactionManager;
    private readonly cacheManager: CacheManager;
    private readonly customOptions: BaseLoginOptions;
    private readonly domainUrl: string;
    private readonly tokenIssuer: string;
    private readonly defaultScope: string;
    private readonly scope: string;
    private readonly cookieStorage: ClientStorage;
    private readonly sessionCheckExpiryDays: number;
    private readonly orgHintCookieName: string;
    private readonly isConnectedCookieName: string;
    private readonly nowProvider: () => number | Promise<number>;
    private readonly httpTimeoutMs: number;

    cacheLocation: CacheLocation;
    private worker: Worker;

    constructor(private options: EarthoOneOptions) {
        typeof window !== 'undefined' && validateCrypto();

        options.domain = options.domain || "one.eartho.world";
        if (options.cache && options.cacheLocation) {
            console.warn(
                'Both `cache` and `cacheLocation` options have been specified in the earthoOne configuration; ignoring `cacheLocation` and using `cache`.'
            );
        }

        let cache: ICache;

        if (options.cache) {
            cache = options.cache;
        } else {
            this.cacheLocation = options.cacheLocation || CACHE_LOCATION_MEMORY;

            if (!cacheFactory(this.cacheLocation)) {
                throw new Error(`Invalid cache location "${this.cacheLocation}"`);
            }

            cache = cacheFactory(this.cacheLocation)();
        }

        this.httpTimeoutMs = options.httpTimeoutInSeconds
            ? options.httpTimeoutInSeconds * 1000
            : DEFAULT_FETCH_TIMEOUT_MS;

        this.cookieStorage =
            options.legacySameSiteCookie === false
                ? CookieStorage
                : CookieStorageWithLegacySameSite;

        this.isConnectedCookieName = buildisConnectedCookieName(
            this.options.client_id
        );

        this.sessionCheckExpiryDays =
            options.sessionCheckExpiryDays || DEFAULT_SESSION_CHECK_EXPIRY_DAYS;

        const transactionStorage = options.useCookiesForTransactions
            ? this.cookieStorage
            : SessionStorage;

        this.scope = this.options.scope;

        this.transactionManager = new TransactionManager(
            transactionStorage,
            this.options.client_id
        );

        this.nowProvider = this.options.nowProvider || DEFAULT_NOW_PROVIDER;

        this.cacheManager = new CacheManager(
            cache,
            !cache.allKeys
                ? new CacheKeyManifest(cache, this.options.client_id)
                : null,
            this.nowProvider
        );

        this.domainUrl = getDomain(this.options.domain);
        this.tokenIssuer = 'https://one.eartho.world/';
        this.options.useRefreshTokens = true;
        this.options.cacheLocation = 'localstorage';

        this.defaultScope = getUniqueScopes(
            'openid',
            this.options?.advancedOptions?.defaultScope !== undefined
                ? this.options.advancedOptions.defaultScope
                : DEFAULT_SCOPE
        );

        // If using refresh tokens, automatically specify the `offline_access` scope.
        // Note we cannot add this to 'defaultScope' above as the scopes are used in the
        // cache keys - changing the order could invalidate the keys
        if (this.options.useRefreshTokens) {
            this.scope = getUniqueScopes(this.scope, 'offline_access');
        }

        // Don't use web workers unless using refresh tokens in memory and not IE11
        if (
            typeof window !== 'undefined' &&
            window.Worker &&
            this.options.useRefreshTokens &&
            this.cacheLocation === CACHE_LOCATION_MEMORY &&
            supportWebWorker()
        ) {
            this.worker = new TokenWorker();
        }

        this.customOptions = getCustomInitialOptions(options);
    }

    private _url(path: string) {
        const earthoOne = encodeURIComponent(
            btoa(JSON.stringify(this.options.earthoOne || DEFAULT_EARTHO_CLIENT))
        );
        return `${this.domainUrl}${path}&earthoOne=${earthoOne}`;
    }

    /**
     * ```js
     * try {
     *  await earthoOne.connectWithPopup(options);
     * } catch(e) {
     *  if (e instanceof PopupCancelledError) {
     *    // Popup was closed before login completed
     *  }
     * }
     * ```
     *
     * Opens a popup with the `/authorize` URL using the parameters
     * provided as arguments. Random and secure `state` and `nonce`
     * parameters will be auto-generated. If the response is successful,
     * results will be valid according to their expiration times.
     *
     * IMPORTANT: This method has to be called from an event handler
     * that was started by the user like a button click, for example,
     * otherwise the popup will be blocked in most browsers.
     *
     * @param options
     * @param config
     */
    public async connectWithPopup(
        options?: PopupConnectOptions,
        config?: PopupConfigOptions
    ) {
        //options = options || {};
        config = config || {};

        if (!options.access_id) {
            throw new Error('PopupConnectOptions.accessId must be defined');
        }

        if (!config.popup) {
            config.popup = openPopup('');

            if (!config.popup) {
                throw new Error(
                    'Unable to open a popup for connectWithPopup - window.open returned `null`'
                );
            }
        }

        const { ...authorizeOptions } = options;
        const stateIn = encode(createRandomString());
        const nonceIn = encode(createRandomString());
        const code_verifier = createRandomString();
        const code_challengeBuffer = await sha256(code_verifier);
        const code_challenge = bufferToBase64UrlEncoded(code_challengeBuffer);

        const params = this._getParams(
            authorizeOptions,
            stateIn,
            nonceIn,
            code_challenge,
            this.options.redirect_uri || window.location.origin,
            options.access_id
        );

        const url = this._connectUrl({
            ...params,
            response_mode: 'web_message'
        });

        config.popup.location.href = url;

        const codeResult = await runPopup({
            ...config,
            timeoutInSeconds:
                config.timeoutInSeconds ||
                this.options.authorizeTimeoutInSeconds ||
                DEFAULT_AUTHORIZE_TIMEOUT_IN_SECONDS
        });

        if (stateIn !== codeResult.state) {
            throw new Error('Invalid state');
        }

        const authResult = await oauthToken(
            {
                audience: params.audience,
                scope: params.scope,
                baseUrl: `https://api.eartho.world/access/oauth/token`,
                client_id: this.options.client_id,
                code_verifier,
                code: codeResult.code,
                access_id: options.access_id,
                grant_type: 'authorization_code',
                redirect_uri: params.redirect_uri,
                earthoOne: this.options.earthoOne,
                useFormData: this.options.useFormData,
                timeout: this.httpTimeoutMs
            } as OAuthTokenOptions,
            this.worker
        );

        const decodedToken = await this._verifyIdToken(
            authResult.id_token,
            nonceIn
        );

        const cacheEntry = {
            ...authResult,
            decodedToken,
            scope: params.scope,
            audience: params.audience || 'default',
            client_id: this.options.client_id
        };

        await this.cacheManager.set(cacheEntry);

        this.cookieStorage.save(this.isConnectedCookieName, true, {
            daysUntilExpire: this.sessionCheckExpiryDays,
            cookieDomain: this.options.cookieDomain
        });
    }

    /**
     * After the browser redirects back to the callback page,
     * call `handleRedirectCallback` to handle success and error
     * responses from EarthoOne. If the response is successful, results
     * will be valid according to their expiration times.
     */
    public async handleRedirectCallback<TAppState = any>(
        url: string = window.location.href
    ): Promise<RedirectLoginResult<TAppState>> {
        const queryStringFragments = url.split('?').slice(1);

        if (queryStringFragments.length === 0) {
            throw new Error('There are no query params available for parsing.');
        }

        const { state, code, error, error_description } = parseQueryResult(
            queryStringFragments.join('')
        );

        const transaction = this.transactionManager.get();

        if (!transaction) {
            throw new Error('Invalid transactionManager state');
        }

        this.transactionManager.remove();

        if (error) {
            throw new AuthenticationError(
                error,
                error_description,
                state,
                transaction.appState
            );
        }

        // Transaction should have a `code_verifier` to do PKCE for CSRF protection
        if (
            !transaction.code_verifier ||
            (transaction.state && transaction.state !== state)
        ) {
            throw new Error('Invalid state' + transaction.state + " ~~ " + state);
        }

        const tokenOptions = {
            audience: transaction.audience,
            scope: transaction.scope,
            baseUrl: `https://api.eartho.world/access/oauth/token`,
            client_id: this.options.client_id,
            code_verifier: transaction.code_verifier,
            code: code,
            access_id: transaction.access_id,
            grant_type: 'authorization_code',
            earthoOne: this.options.earthoOne,
            useFormData: this.options.useFormData,
            timeout: this.httpTimeoutMs
        } as OAuthTokenOptions;
        // some old versions of the SDK might not have added redirect_uri to the
        // transaction, we dont want the key to be set to undefined.
        if (undefined !== transaction.redirect_uri) {
            tokenOptions.redirect_uri = transaction.redirect_uri;
        }

        const authResult = await oauthToken(tokenOptions, this.worker);

        const decodedToken = await this._verifyIdToken(
            authResult.id_token,
            transaction.nonce
        );

        await this.cacheManager.set({
            ...authResult,
            decodedToken,
            audience: transaction.audience,
            scope: transaction.scope,
            ...(authResult.scope ? { oauthTokenScope: authResult.scope } : null),
            client_id: this.options.client_id
        });

        this.cookieStorage.save(this.isConnectedCookieName, true, {
            daysUntilExpire: this.sessionCheckExpiryDays,
            cookieDomain: this.options.cookieDomain
        });

        return {
            appState: transaction.appState
        };
    }


    /**
     * ```js
     * await earthoOne.connectWithRedirect(options);
     * ```
     *
     * Performs a redirect to `/authorize` using the parameters
     * provided as arguments. Random and secure `state` and `nonce`
     * parameters will be auto-generated.
     *
     * @param options
     */
    public async connectWithRedirect<TAppState = any>(
        options: RedirectConnectOptions<TAppState> = {}
    ) {
        const { redirectMethod, ...urlOptions } = options;
        const url = await this.buildConnectUrl(urlOptions);
        window.location[redirectMethod || 'assign'](url);
    }

    /**
     * Fetches a new access token and returns it.
     *
     * @param options
     */
    public async getIdToken(
        options?: GetTokenSilentlyOptions
    ): Promise<string>;

    /**
     * Fetches a new access token, and either returns just the access token (the default) or the response from the /oauth/token endpoint, depending on the `detailedResponse` option.
     *
     * ```js
     * const token = await earthoOne.getTokenSilently(options);
     * ```
     *
     * If there's a valid token stored and it has more than 60 seconds
     * remaining before expiration, return the token. Otherwise, attempt
     * to obtain a new token.
     *
     * A new token will be obtained either by opening an iframe or a
     * refresh token (if `useRefreshTokens` is `true`)

     * If iframes are used, opens an iframe with the `/authorize` URL
     * using the parameters provided as arguments. Random and secure `state`
     * and `nonce` parameters will be auto-generated. If the response is successful,
     * results will be validated according to their expiration times.
     *
     * If refresh tokens are used, the token endpoint is called directly with the
     * 'refresh_token' grant. If no refresh token is available to make this call,
     * the SDK falls back to using an iframe to the '/authorize' URL.
     *
     * This method may use a web worker to perform the token call if the in-memory
     * cache is used.
     *
     * If an `audience` value is given to this function, the SDK always falls
     * back to using an iframe to make the token exchange.
     *
     * Note that in all cases, falling back to an iframe requires access to
     * the `earthoOne` cookie.
     *
     * @param options
     */
    public async getIdToken(
        options: GetTokenSilentlyOptions = {}
    ): Promise<string | GetTokenSilentlyVerboseResponse> {
        const { ignoreCache, ...getTokenOptions } = {
            audience: this.options.audience,
            ignoreCache: false,
            ...options,
            scope: getUniqueScopes(this.defaultScope, this.scope, options.scope)
        };

        return singlePromise(
            () =>
                this._connectSilently({
                    ignoreCache,
                    ...getTokenOptions
                }),
            `${this.options.client_id}::${getTokenOptions.audience}::${getTokenOptions.scope}`
        );
    }

    public async connectSilently(
        options: GetTokenSilentlyOptions = {}
    ): Promise<string | GetTokenSilentlyVerboseResponse> {
        const { ignoreCache, ...getTokenOptions } = {
            audience: this.options.audience,
            ignoreCache: false,
            ...options,
            scope: getUniqueScopes(this.defaultScope, this.scope, options.scope)
        };

        return singlePromise(
            () =>
                this._connectSilently({
                    ignoreCache,
                    ...getTokenOptions
                }),
            `${this.options.client_id}::${getTokenOptions.audience}::${getTokenOptions.scope}`
        );
    }


    private async _connectSilently(
        options: GetTokenSilentlyOptions = {}
    ): Promise<string | GetTokenSilentlyVerboseResponse> {
        const { ignoreCache, ...getTokenOptions } = options;

        // Check the cache before acquiring the lock to avoid the latency of
        // `lock.acquireLock` when the cache is populated.
        if (!ignoreCache) {
            const entry = await this._getEntryFromCache({
                scope: getTokenOptions.scope,
                audience: getTokenOptions.audience || 'default',
                client_id: this.options.client_id,
                getDetailedEntry: options.detailedResponse
            });

            if (entry) {
                return entry;
            }
        }

        if (
            await retryPromise(
                () => lock.acquireLock(GET_TOKEN_SILENTLY_LOCK_KEY, 5000),
                10
            )
        ) {
            try {
                // Check the cache a second time, because it may have been populated
                // by a previous call while this call was waiting to acquire the lock.
                if (!ignoreCache) {
                    const entry = await this._getEntryFromCache({
                        scope: getTokenOptions.scope,
                        audience: getTokenOptions.audience || 'default',
                        client_id: this.options.client_id,
                        getDetailedEntry: options.detailedResponse
                    });

                    if (entry) {
                        return entry;
                    }
                }

                const authResult = await this._getTokenUsingRefreshToken(getTokenOptions);

                await this.cacheManager.set({
                    client_id: this.options.client_id,
                    ...authResult
                });

                this.cookieStorage.save(this.isConnectedCookieName, true, {
                    daysUntilExpire: this.sessionCheckExpiryDays,
                    cookieDomain: this.options.cookieDomain
                });

                if (options.detailedResponse) {
                    const {
                        id_token,
                        access_token,
                        oauthTokenScope,
                        expires_in
                    } = authResult;

                    return {
                        id_token,
                        access_token,
                        ...(oauthTokenScope ? { scope: oauthTokenScope } : null),
                        expires_in
                    };
                }

                return authResult.id_token;
            } finally {
                await lock.releaseLock(GET_TOKEN_SILENTLY_LOCK_KEY);
            }
        } else {
            throw new TimeoutError();
        }
    }

    /**
     * ```js
     * const user = await earthoOne.getUser();
     * ```
     *
     * Returns the user information if available (decoded
     * from the `id_token`).
     *
     * If you provide an audience or scope, they should match an existing Access Token
     * (the SDK stores a corresponding ID Token with every Access Token, and uses the
     * scope and audience to look up the ID Token)
     *
     * @typeparam TUser The type to return, has to extend {@link User}.
     * @param options
     */
    public async getUser<TUser extends User>(
        options: GetUserOptions = {}
    ): Promise<TUser | undefined> {
        const audience = options.audience || this.options.audience || 'default';
        const scope = getUniqueScopes(this.defaultScope, this.scope, options.scope);

        const cache = await this.cacheManager.get(
            new CacheKey({
                client_id: this.options.client_id,
                audience,
                scope
            })
        );

        return cache && cache.decodedToken && (cache.decodedToken.user as TUser);
    }

    /**
     * ```js
     * const isConnected = await earthoOne.isConnected();
     * ```
     *
     * Returns `true` if there's valid information stored,
     * otherwise returns `false`.
     *
     */
    public async isConnected() {
        const user = await this.getUser();
        return !!user;
    }

    public async checkSession(options?: GetTokenSilentlyOptions) {
        if (!this.cookieStorage.get(this.isConnectedCookieName)) {
            if (!this.cookieStorage.get(OLD_IS_AUTHENTICATED_COOKIE_NAME)) {
                return;
            } else {
                // Migrate the existing cookie to the new name scoped by client ID
                this.cookieStorage.save(this.isConnectedCookieName, true, {
                    daysUntilExpire: this.sessionCheckExpiryDays,
                    cookieDomain: this.options.cookieDomain
                });

                this.cookieStorage.remove(OLD_IS_AUTHENTICATED_COOKIE_NAME);
            }
        }

        try {
            await this.connectSilently(options);
        } catch (error) {
            if (!RECOVERABLE_ERRORS.includes(error.error)) {
                throw error;
            }
        }
    }

    /**
     * ```js
     * await earthoOne.buildLogoutUrl(options);
     * ```
     *
     * Builds a URL to the logout endpoint using the parameters provided as arguments.
     * @param options
     */
    public buildLogoutUrl(options: LogoutUrlOptions = {}): string {
        if (options.client_id !== null) {
            options.client_id = options.client_id || this.options.client_id;
        } else {
            delete options.client_id;
        }

        const { federated, ...logoutOptions } = options;
        const federatedQuery = federated ? `&federated` : '';
        const url = this._url(`/v2/logout?${createQueryParams(logoutOptions)}`);

        return url + federatedQuery;
    }

    /**
     * ```js
     * earthoOne.logout();
     * ```
     *
     * Clears the application session and performs a redirect to `/v2/logout`, using
     * the parameters provided as arguments, to clear the EarthoOne session.
     *
     * **Note:** If you are using a custom cache, and specifying `localOnly: true`, and you want to perform actions or read state from the SDK immediately after logout, you should `await` the result of calling `logout`.
     *
     * If the `federated` option is specified it also clears the Identity Provider session.
     * If the `localOnly` option is specified, it only clears the application session.
     * It is invalid to set both the `federated` and `localOnly` options to `true`,
     * and an error will be thrown if you do.
     * [Read more about how Logout works at EarthoOne]EarthoOne.
     *
     * @param options
     */
    public logout(options: LogoutOptions = {}): Promise<void> | void {
        const { localOnly, ...logoutOptions } = options;

        if (localOnly && logoutOptions.federated) {
            throw new Error(
                'It is invalid to set both the `federated` and `localOnly` options to `true`'
            );
        }

        const postCacheClear = () => {
            this.cookieStorage.remove(this.orgHintCookieName);
            this.cookieStorage.remove(this.isConnectedCookieName);

            if (localOnly) {
                return;
            }

            const url = this.buildLogoutUrl(logoutOptions);

            window.location.assign(url);
        };

        if (this.options.cache) {
            return this.cacheManager.clear().then(() => postCacheClear());
        } else {
            this.cacheManager.clearSync();
            postCacheClear();
        }
    }

    private async _getTokenUsingRefreshToken(
        options: GetTokenSilentlyOptions
    ): Promise<GetTokenSilentlyResult> {
        options.scope = getUniqueScopes(
            this.defaultScope,
            this.options.scope,
            options.scope
        );

        const cache = await this.cacheManager.get(
            new CacheKey({
                scope: options.scope,
                audience: options.audience || 'default',
                client_id: this.options.client_id
            })
        );

        // If you don't have a refresh token in memory
        // and you don't have a refresh token in web worker memory
        // fallback to an iframe.
        if ((!cache || !cache.refresh_token) && !this.worker) {
            throw {
                error: 'login_required',
                error_message: 'Login required'
            };
        }

        const redirect_uri =
            options.redirect_uri ||
            this.options.redirect_uri ||
            window.location.origin;

        let tokenResult: TokenEndpointResponse;

        const {
            scope,
            audience,
            ignoreCache,
            timeoutInSeconds,
            detailedResponse,
            ...customOptions
        } = options;

        const timeout =
            typeof options.timeoutInSeconds === 'number'
                ? options.timeoutInSeconds * 1000
                : null;

        try {
            tokenResult = await oauthToken(
                {
                    ...this.customOptions,
                    ...customOptions,
                    audience,
                    scope,
                    baseUrl: `https://api.eartho.world/access/oauth/refreshtoken`,
                    client_id: this.options.client_id,
                    grant_type: 'refresh_token',
                    access_id: '',
                    refresh_token: cache && cache.refresh_token,
                    redirect_uri,
                    ...(timeout && { timeout }),
                    earthoOne: this.options.earthoOne,
                    useFormData: this.options.useFormData,
                    timeout: this.httpTimeoutMs
                } as RefreshTokenOptions,
                this.worker
            );
        } catch (e) {
            if (
                // The web worker didn't have a refresh token in memory so
                // fallback to an iframe.
                e.message === MISSING_REFRESH_TOKEN_ERROR_MESSAGE ||
                // A refresh token was found, but is it no longer valid.
                // Fallback to an iframe.
                (e.message &&
                    e.message.indexOf(INVALID_REFRESH_TOKEN_ERROR_MESSAGE) > -1)
            ) {
                // return await this._getTokenFromIFrame(options);
            }

            throw e;
        }

        const decodedToken = await this._verifyIdToken(tokenResult.id_token);

        return {
            ...tokenResult,
            decodedToken,
            scope: options.scope,
            oauthTokenScope: tokenResult.scope,
            audience: options.audience || 'default'
        };
    }

    private async _getEntryFromCache({
        scope,
        audience,
        client_id,
        getDetailedEntry = false
    }: {
        scope: string;
        audience: string;
        client_id: string;
        getDetailedEntry?: boolean;
    }) {
        const entry = await this.cacheManager.get(
            new CacheKey({
                scope,
                audience,
                client_id
            }),
            60 // get a new token if within 60 seconds of expiring
        );

        if (entry && entry.id_token) {
            if (getDetailedEntry) {
                const { id_token, access_token, oauthTokenScope, expires_in } = entry;

                return {
                    id_token,
                    access_token,
                    ...(oauthTokenScope ? { scope: oauthTokenScope } : null),
                    expires_in
                };
            }

            return entry.id_token;
        }
    }

    private _getParams(
        authorizeOptions: BaseLoginOptions,
        state: string,
        nonce: string,
        code_challenge: string,
        redirect_uri: string,
        access_id: string
    ): AuthorizeOptions {
        // These options should be excluded from the authorize URL,
        // as they're options for the client and not for the IdP.
        // ** IMPORTANT ** If adding a new client option, include it in this destructure list.
        const {
            useRefreshTokens,
            useCookiesForTransactions,
            useFormData,
            earthoOne,
            cacheLocation,
            advancedOptions,
            detailedResponse,
            nowProvider,
            authorizeTimeoutInSeconds,
            legacySameSiteCookie,
            sessionCheckExpiryDays,
            domain,
            leeway,
            httpTimeoutInSeconds,
            ...loginOptions
        } = this.options;

        return {
            ...loginOptions,
            ...authorizeOptions,
            scope: getUniqueScopes(
                this.defaultScope,
                this.scope,
                authorizeOptions.scope
            ),
            response_type: 'code',
            response_mode: 'query',
            state,
            nonce,
            redirect_uri: redirect_uri || this.options.redirect_uri,
            access_id,
            code_challenge,
            code_challenge_method: 'S256'
        };
    }

    private _connectUrl(authorizeOptions: AuthorizeOptions) {
        return this._url(`/connect?${createQueryParams(authorizeOptions)}`);
    }

    private async _verifyIdToken(id_token: string, nonce?: string) {
        const now = await this.nowProvider();

        return verifyIdToken({
            iss: this.tokenIssuer,
            aud: this.options.client_id,
            id_token,
            nonce,
            leeway: this.options.leeway,
            max_age: this._parseNumber(this.options.max_age),
            now
        });
    }

    private _parseNumber(value: any): number {
        if (typeof value !== 'string') {
            return value;
        }
        return parseInt(value, 10) || undefined;
    }

    /**
     * ```js
     * await earthoOne.buildAuthorizeUrl(options);
     * ```
     *
     * Builds an `/authorize` URL for loginWithRedirect using the parameters
     * provided as arguments. Random and secure `state` and `nonce`
     * parameters will be auto-generated.
     *
     * @param options
     */
    public async buildConnectUrl(
        options: RedirectConnectOptions = {}
    ): Promise<string> {
        const { redirect_uri, access_id, appState, ...authorizeOptions } = options;

        const stateIn = encode(createRandomString());
        const nonceIn = encode(createRandomString());
        const code_verifier = createRandomString();
        const code_challengeBuffer = await sha256(code_verifier);
        const code_challenge = bufferToBase64UrlEncoded(code_challengeBuffer);
        const fragment = options.fragment ? `#${options.fragment}` : '';

        const params = this._getParams(
            authorizeOptions,
            stateIn,
            nonceIn,
            code_challenge,
            redirect_uri,
            access_id
        );

        const url = this._connectUrl(params);

        this.transactionManager.create({
            nonce: nonceIn,
            code_verifier,
            appState,
            access_id: access_id,
            scope: params.scope,
            audience: params.audience || 'default',
            redirect_uri: params.redirect_uri,
            state: stateIn
        });

        return url + fragment;
    }

}
