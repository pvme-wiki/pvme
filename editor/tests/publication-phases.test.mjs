import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionStatus, canCheckPublication, moderatorPublicationLinks } from '../src/hosted-workflow.mjs';

const session = { configured: true, user: { id: 'moderator', role: 'moderator' }, capabilities: { review: true, publication: true } };
const publication = (phase, state = 'awaiting_deployment') => ({ pipeline: 'content-pin-v1', phase, state });
const review = (phase, state) => ({ status: 'publishing', publication: publication(phase, state) });
const stageLabels = {
  content_review: 'Approved · awaiting content merge',
  website_update: 'Content merged · website update pending',
  deployment: 'Website update merged · checking publication',
};

test('each pending bridge phase names the verified step and never claims publication', () => {
  for (const [phase, label] of Object.entries(stageLabels)) {
    for (const state of ['queued', 'working', 'retry', 'awaiting_merge', 'awaiting_deployment']) {
      for (const status of ['approved', 'publishing']) {
        const value = publication(phase, state);
        const before = structuredClone(value);
        const [actual, description] = submissionStatus(status, value);
        assert.equal(actual, label);
        assert.match(description, /not been verified|before this version can be verified/);
        assert.doesNotMatch(description, /send.*review|resubmit|this approved version is live/i);
        assert.deepEqual(value, before);
        assert.equal(canCheckPublication({ status, publication: value }, session), true);
      }
    }
  }
  assert.match(submissionStatus('publishing', publication('content_review'))[1], /maintainer needs to merge.*guide repository/);
  assert.match(submissionStatus('publishing', publication('website_update'))[1], /maintainer needs to merge the website update/);
  assert.match(submissionStatus('publishing', publication('website_update'))[1], /keep editing your draft; this submitted version stays unchanged/);
});

test('only a consistently verified terminal bridge result is labeled Published', () => {
  assert.deepEqual(submissionStatus('published', publication('live', 'published')), ['Published', 'This approved version has been verified on the live website.']);
  for (const [status, value] of [
    ['publishing', publication('live', 'published')],
    ['published', publication('live', 'working')],
    ['published', publication('deployment', 'published')],
    ['approved', publication('deployment', 'published')],
  ]) assert.equal(submissionStatus(status, value)[0], 'Status unavailable');
  assert.equal(canCheckPublication({ status: 'published', publication: publication('live', 'published') }, session), false);
});

test('unknown pipeline, phase or worker state fails closed in presentation and check eligibility', () => {
  for (const value of [
    { pipeline: 'future-pipeline', phase: 'live', state: 'published' },
    { pipeline: null, phase: 'live', state: 'published' },
    { pipeline: 'content-pin-v1', state: 'queued' },
    publication('unknown'), publication(null), publication('deployment', 'unknown'),
  ]) {
    assert.equal(submissionStatus('published', value)[0], 'Status unavailable');
    assert.equal(submissionStatus('publishing', value)[0], 'Status unavailable');
    assert.equal(canCheckPublication({ status: 'publishing', publication: value }, session), false);
    assert.deepEqual(moderatorPublicationLinks({ publication: value }, session), []);
  }
});

test('paused and replaced bridge submissions retain the existing recovery rules', () => {
  for (const phase of ['content_review', 'website_update', 'deployment']) {
    const paused = { ...publication(phase, 'blocked'), requiresFreshReview: false };
    assert.equal(submissionStatus('publishing', paused)[0], 'Publication paused');
    assert.doesNotMatch(submissionStatus('publishing', paused)[1], /draft|review again/);
    assert.equal(canCheckPublication({ status: 'publishing', publication: paused }, session), false);
    const replacement = { ...paused, replacementId: 'fresh-snapshot' };
    assert.equal(submissionStatus('publishing', replacement)[0], 'Replaced');
  }
});

test('legacy submissions retain their existing status copy and singular review link', () => {
  assert.deepEqual(submissionStatus('publishing', { state: 'awaiting_deployment' }), ['Publishing', 'Publication is in progress. This version is not confirmed live.']);
  assert.deepEqual(submissionStatus('published'), ['Published', 'This approved version is live.']);
  const old = { publication: { reviewUrl: 'https://github.com/legacy/private-app/pull/23' } };
  assert.deepEqual(moderatorPublicationLinks(old, session), [{ url: old.publication.reviewUrl, label: 'View pull request' }]);
});

test('both bridge review links require an active configured moderator or admin capability', () => {
  const value = { publication: { ...publication('website_update'), contentReviewUrl: 'https://github.com/pvme-wiki/guides/pull/23', websiteReviewUrl: 'https://github.com/owner/app/pull/42' } };
  const before = structuredClone(value);
  for (const role of ['moderator', 'admin']) {
    assert.deepEqual(moderatorPublicationLinks(value, { ...session, user: { role } }), [
      { url: value.publication.contentReviewUrl, label: 'View content pull request' },
      { url: value.publication.websiteReviewUrl, label: 'View website update' },
    ]);
  }
  for (const identity of [null, { ...session, configured: false }, { ...session, user: null }, { ...session, user: { role: 'contributor' } }, { ...session, capabilities: { review: false } }]) {
    assert.deepEqual(moderatorPublicationLinks(value, identity), []);
    assert.equal(canCheckPublication(review('website_update'), identity), false);
  }
  assert.deepEqual(value, before);
});

test('review link validation accepts only canonical HTTPS GitHub pull request routes', () => {
  for (const url of ['javascript:alert(1)', 'http://github.com/a/b/pull/2', 'https://github.com.evil.test/a/b/pull/2', 'https://github.com/a/b/settings', 'https://user:secret@github.com/a/b/pull/3', 'https://github.com:8443/a/b/pull/3', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/2/files', '/a/b/pull/3', null]) {
    const result = moderatorPublicationLinks({ publication: { ...publication('website_update'), contentReviewUrl: url, websiteReviewUrl: 'https://github.com/owner/app/pull/42' } }, session);
    assert.deepEqual(result, [{ url: 'https://github.com/owner/app/pull/42', label: 'View website update' }]);
  }
  assert.deepEqual(moderatorPublicationLinks({ publication: { ...publication('website_update'), reviewUrl: 'https://github.com/legacy/app/pull/1' } }, session), []);
});
