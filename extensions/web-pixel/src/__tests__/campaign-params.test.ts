import { describe, expect, it } from 'vitest';
import { CAMPAIGN_PARAMS, calculateCampaignParams } from '../campaign-params';

const BASE = 'https://lightinderm.com/collections/capsules';

describe('calculateCampaignParams', () => {
  it('emits plain last-touch keys and $initial_ first-touch keys (Klaviyo URL)', () => {
    const { lastTouchCampaignParams, firstTouchCampaignParams } = calculateCampaignParams(
      `${BASE}?utm_source=Klaviyo&utm_medium=campaign&utm_campaign=rentree&_kx=abc123`
    );
    expect(lastTouchCampaignParams).toEqual({
      utm_source: 'Klaviyo',
      utm_medium: 'campaign',
      utm_campaign: 'rentree',
      _kx: 'abc123',
    });
    expect(firstTouchCampaignParams).toEqual({
      $initial_utm_source: 'Klaviyo',
      $initial_utm_medium: 'campaign',
      $initial_utm_campaign: 'rentree',
      $initial__kx: 'abc123',
    });
    // The historical bug: a `$`-prefixed last-touch key that PostHog never reads.
    expect(lastTouchCampaignParams).not.toHaveProperty('$utm_source');
  });

  it('omits missing params on both sides — never sends nulls', () => {
    const { lastTouchCampaignParams, firstTouchCampaignParams } = calculateCampaignParams(
      `${BASE}?utm_source=instagram`
    );
    expect(Object.keys(lastTouchCampaignParams)).toEqual(['utm_source']);
    expect(Object.keys(firstTouchCampaignParams)).toEqual(['$initial_utm_source']);
    expect(Object.values(lastTouchCampaignParams)).not.toContain(null);
    expect(Object.values(firstTouchCampaignParams)).not.toContain(null);
  });

  it('omits empty-string params', () => {
    const { lastTouchCampaignParams, firstTouchCampaignParams } = calculateCampaignParams(
      `${BASE}?utm_source=&utm_term=&gclid=1`
    );
    expect(lastTouchCampaignParams).toEqual({ gclid: '1' });
    expect(firstTouchCampaignParams).toEqual({ $initial_gclid: '1' });
  });

  it('decodes percent- and plus-encoded values', () => {
    const { lastTouchCampaignParams } = calculateCampaignParams(
      `${BASE}?utm_campaign=Spring%20Sale&utm_term=a+b`
    );
    expect(lastTouchCampaignParams).toEqual({ utm_campaign: 'Spring Sale', utm_term: 'a b' });
  });

  it('returns empty objects when there are no params or only a hash', () => {
    expect(calculateCampaignParams(BASE)).toEqual({
      firstTouchCampaignParams: {},
      lastTouchCampaignParams: {},
    });
    expect(calculateCampaignParams(`${BASE}#reviews`)).toEqual({
      firstTouchCampaignParams: {},
      lastTouchCampaignParams: {},
    });
  });

  it('ignores non-campaign params', () => {
    const { lastTouchCampaignParams } = calculateCampaignParams(`${BASE}?variant=123&page=2`);
    expect(lastTouchCampaignParams).toEqual({});
  });

  it('never throws on an invalid URL', () => {
    expect(() => calculateCampaignParams('not a url')).not.toThrow();
    expect(calculateCampaignParams('not a url')).toEqual({
      firstTouchCampaignParams: {},
      lastTouchCampaignParams: {},
    });
  });

  it('covers the five utm_* params', () => {
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      expect(CAMPAIGN_PARAMS).toContain(p);
    }
  });
});
