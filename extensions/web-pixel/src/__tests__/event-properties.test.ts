import { describe, expect, it } from 'vitest';
import { calculateCampaignParams } from '../campaign-params';
import { buildEventProperties, stripNulls } from '../event-properties';

const BOOT_URL = 'https://lightinderm.com/pages/rentree-2026?utm_source=Klaviyo&utm_medium=campaign';

const base = { $browser: 'Safari', $referrer: '$direct', shop: { name: 'Lightinderm' } };
const customer = { email: 'jane@example.com', firstName: 'Jane' };
const setOnceBase = {
  $initial_browser: 'Safari',
  $initial_device_type: null, // ua-parser returns undefined on desktop
  $initial_referrer: '$direct',
};
const initCampaign = calculateCampaignParams(BOOT_URL);

const build = (overrides: Partial<Parameters<typeof buildEventProperties>[0]> = {}) =>
  buildEventProperties({
    base,
    customer,
    initCampaign,
    eventHref: BOOT_URL,
    anonymous: false,
    setOnceBase,
    ...overrides,
  });

describe('stripNulls', () => {
  it('removes null and undefined values, keeps falsy non-null ones', () => {
    expect(stripNulls({ a: null, b: undefined, c: 0, d: '', e: false, f: 'x' })).toEqual({
      c: 0,
      d: '',
      e: false,
      f: 'x',
    });
  });
});

describe('buildEventProperties', () => {
  it('uses the event URL for last-touch campaign params', () => {
    const props = build({
      eventHref: 'https://lightinderm.com/products/protocole-lift?utm_source=instagram&utm_medium=influence',
    });
    expect(props.utm_source).toBe('instagram');
    expect(props.utm_medium).toBe('influence');
    expect(props).not.toHaveProperty('$utm_source');
  });

  it('sends no utm_* when the event URL has none, but keeps boot first-touch in $set_once', () => {
    const props = build({ eventHref: 'https://lightinderm.com/checkouts/cn/abc/information' });
    expect(props).not.toHaveProperty('utm_source');
    expect(props.$set_once).toMatchObject({ $initial_utm_source: 'Klaviyo', $initial_utm_medium: 'campaign' });
  });

  it('falls back to the boot snapshot for events without a document context', () => {
    const props = build({ eventHref: undefined });
    expect(props.utm_source).toBe('Klaviyo');
  });

  it('sends no person properties and no customer fields when anonymous', () => {
    const props = build({ anonymous: true });
    expect(props).not.toHaveProperty('$set');
    expect(props).not.toHaveProperty('$set_once');
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('firstName');
    // event-level attribution is still there
    expect(props.utm_source).toBe('Klaviyo');
  });

  it('flattens customer fields into event properties when identified (New vs Returning insights read ordersCount)', () => {
    const props = build({ customer: { ...customer, ordersCount: 3 } });
    expect(props.email).toBe('jane@example.com');
    expect(props.ordersCount).toBe(3);
  });

  it('never puts nulls into $set_once', () => {
    const props = build();
    expect(props.$set_once).not.toHaveProperty('$initial_device_type');
    expect(Object.values(props.$set_once as Record<string, unknown>)).not.toContain(null);
    expect(props.$set_once).toMatchObject({ $initial_browser: 'Safari', $initial_referrer: '$direct' });
  });

  it('limits $set to customer fields', () => {
    const props = build();
    expect(props.$set).toEqual(customer);
  });

  it('omits $set entirely when there is no customer', () => {
    expect(build({ customer: null })).not.toHaveProperty('$set');
    expect(build({ customer: undefined })).not.toHaveProperty('$set');
  });

  it('strips null customer fields so they never clobber existing person properties', () => {
    const props = build({ customer: { email: 'jane@example.com', phone: null, lastName: null } });
    expect(props.$set).toEqual({ email: 'jane@example.com' });
  });

  it('keeps first touch on the boot URL even when the event URL carries other UTMs', () => {
    const props = build({
      eventHref: 'https://lightinderm.com/products/protocole-lift?utm_source=instagram&utm_medium=influence',
    });
    expect(props.$set_once).toMatchObject({ $initial_utm_source: 'Klaviyo', $initial_utm_medium: 'campaign' });
    expect((props.$set_once as Record<string, unknown>).$initial_utm_source).not.toBe('instagram');
  });

  it('preserves base properties', () => {
    const props = build();
    expect(props).toMatchObject(base);
  });
});
