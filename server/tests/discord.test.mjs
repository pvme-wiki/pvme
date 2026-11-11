import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordProvider } from '../auth.mjs';
const config = { clientId: '123456', clientSecret: 'fixture-secret-not-a-live-credential', redirectUri: 'https://pvme.example/api/editor/auth/discord/callback' };
test('Discord uses authorization code with identify only, form exchange and ephemeral token revocation', async () => {
  const calls = [];
  const provider = createDiscordProvider(config, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/token')) {
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(init.body.get('client_id'), config.clientId);
      assert.equal(init.body.get('client_secret'), config.clientSecret);
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      assert.equal(init.body.get('redirect_uri'), config.redirectUri);
      return Response.json({ access_token: 'ephemeral-token', refresh_token: 'unused-refresh-token', token_type: 'Bearer', scope: 'identify' });
    }
    if (url.endsWith('/users/@me')) {
      assert.equal(init.headers.Authorization, 'Bearer ephemeral-token');
      return Response.json({ id: '123456789', username: 'fixture', global_name: 'Friendly name', email: 'must-not-be-returned@example.test' });
    }
    assert.equal(url, 'https://discord.com/api/oauth2/token/revoke');
    assert.equal(init.body.get('token'), 'ephemeral-token');
    return new Response(null, { status: 200 });
  } });
  const url = new URL(provider.authorize('state-fixture'));
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-fixture');
  assert.deepEqual(await provider.identity('code-fixture'), { discordId: '123456789', displayName: 'Friendly name' });
  assert.equal(calls.length, 3);
});
test('unexpected Discord scopes and invalid identities fail closed', async () => {
  const wrongScope = createDiscordProvider(config, { fetchImpl: async () => Response.json({ access_token: 'fixture', token_type: 'Bearer', scope: 'identify email' }) });
  await assert.rejects(wrongScope.identity('fixture'), error => error.code === 'identity_unavailable');
  let revoked = false;
  const bot = createDiscordProvider(config, { fetchImpl: async url => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'fixture', token_type: 'Bearer', scope: 'identify' });
    if (url.endsWith('/users/@me')) return Response.json({ id: '123456', username: 'robot', bot: true });
    revoked = true; return new Response(null, { status: 200 });
  } });
  await assert.rejects(bot.identity('fixture'), error => error.code === 'identity_unavailable');
  assert.equal(revoked, true);
});
