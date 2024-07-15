import Provider, { interactionPolicy } from 'oidc-provider';

const { base, Prompt, Check } = interactionPolicy;

const policy = base();
policy.add(
  new Prompt(
    { name: 'noop', requestable: false },
    new Check('foo', 'bar', (ctx) => {
      if (
        ctx.query &&
        ctx.query.scope &&
        ctx.query.scope.includes('offline_access')
      ) {
        ctx.oidc.params.scope = `${ctx.oidc.params.scope} offline_access`;
      }
      return Check.NO_NEED_TO_PROMPT;
    })
  ),
  0
);

const config = {
  clients: [
    {
      client_id: 'testing',
      redirect_uris: ['http://127.0.0.1:3000'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    },
  ],
  routes: {
    authorization: '/authorize', // lgtm [js/hardcoded-credentials]
    token: '/oauth/token',
    end_session: '/v2/logout',
  },
  scopes: ['openid', 'offline_access', 'profile'],
  clientBasedCORS(ctx, origin, client) {
    return true;
  },
  features: {
    webMessageResponseMode: {
      enabled: true,
    },
  },
  rotateRefreshToken: true,
  interactions: {
    policy,
  },
  conformIdTokenClaims: false,
  claims: {
    profile: ['name'],
  },
  async findAccount(ctx, id) {
    return {
      accountId: id,
      async claims() {
        return { sub: id, name: id };
      },
    };
  },
};

export function createApp(opts) {
  const issuer = `http://127.0.0.1:${opts.port || 3000}/`;
  const provider = new Provider(issuer, config);

  provider.use(async (ctx, next) => {
    await next();

    if (ctx.oidc && ctx.oidc.route === 'end_session_success') {
      ctx.redirect('http://127.0.0.1:3000');
    }
  });

  return provider.app;
}
