import React from 'react';

import { RequestError, EarthoClientProvider, EarthoClientProviderProps, UserProfile } from '../../src/client';
import { default as ConfigProvider, ConfigProviderProps } from '../../src/client/use-config';

type FetchUserMock = {
  ok: boolean;
  status: number;
  json?: () => Promise<UserProfile | undefined>;
};

export const user: UserProfile = {
  email: 'foo@example.com',
  emailVerified: true,
  name: 'foo',
  displayName: 'foo',
  picture: 'foo.jpg',
  sub: '1',
  updated_at: null
};

export const withEarthoClientProvider = ({
  user,
  profileUrl,
  loginUrl,
  fetcher
}: EarthoClientProviderProps = {}): React.ComponentType => {
  return (props: any): React.ReactElement => (
    <EarthoClientProvider {...props} user={user} profileUrl={profileUrl} loginUrl={loginUrl} fetcher={fetcher} />
  );
};

export const fetchUserMock = (): Promise<FetchUserMock> => {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(user)
  });
};

export const fetchUserUnauthorizedMock = (): Promise<FetchUserMock> => {
  return Promise.resolve({
    ok: true,
    status: 204,
    json: () => Promise.resolve(undefined)
  });
};

export const fetchUserErrorMock = (): Promise<FetchUserMock> => {
  return Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve(undefined)
  });
};

export const fetchUserNetworkErrorMock = (): Promise<FetchUserMock> => {
  return Promise.reject(new RequestError(0));
};

export const withConfigProvider = ({ loginUrl }: ConfigProviderProps = {}): React.ComponentType => {
  return (props: any): React.ReactElement => <ConfigProvider {...props} loginUrl={loginUrl} />;
};
