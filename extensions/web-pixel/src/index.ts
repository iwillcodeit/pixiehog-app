import type { Context, CustomerPrivacyPayload, PixelEvents, StandardEvents } from '@shopify/web-pixels-extension';
import { register } from '@shopify/web-pixels-extension';
import { v7 as uuidv7 } from 'uuid';
import type { WebPixelSettings } from '../../../common/dto/web-pixel-settings.dto';
import { extractEventUUID } from './validate-uuid';
import { isNumber } from './type-utils';
import type { WebPixelEventsSettings } from '../../../common/dto/web-pixel-events-settings.dto';
import { calculateCampaignParams } from './campaign-params';
import { buildEventProperties } from './event-properties';
import { UAParser } from 'ua-parser-js';
import { getSearchEngine } from './utils';
import { PixieHogPostHog } from './pixiehog-posthog';
import { webPixelToPostHogEcommerceSpecTransformerMap } from './posthog-ecommerce-spec/transformer-map';
import { webPixelToPostHogEcommerceSpecMap } from './posthog-ecommerce-spec/event-map';
type JsonType = string | number | boolean | null | { [key: string]: JsonType } | Array<JsonType> | JsonType[]

register(async (extensionApi) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    analytics,
    browser: { localStorage, sessionStorage },
    init,
    customerPrivacy,
  } = extensionApi;
  const settings = extensionApi.settings as WebPixelSettings & Partial<WebPixelEventsSettings>;
  /**
   * Web Pixel settings can only be strings
   */
  const posthogEcommerceSpecEnabled = String(settings?.posthog_ecommerce_spec || '') == 'true'
  const possibleEvents: (keyof PixelEvents)[] = [
    'cart_viewed',
    'checkout_address_info_submitted',
    'checkout_completed',
    'checkout_contact_info_submitted',
    'checkout_shipping_info_submitted',
    'checkout_started',
    'clicked',
    'collection_viewed',
    'form_submitted',
    'input_blurred',
    'input_focused',
    'page_viewed',
    'payment_info_submitted',
    'product_added_to_cart',
    'product_removed_from_cart',
    'product_viewed',
    'search_submitted',
  ] as const;
  const settingObjectEvents = possibleEvents.filter((event) => (settings as any)[event] == 'true');
  const trackedEventsSetting = (() => {
    try {
      const events = JSON.parse(settings?.tracked_events || '[]') as string[]
      if (!Array.isArray(events)) {
        throw Error('must be array')
      }
      return events;
    } catch (error) {
        return [] as string[]
    }
  })();

  const activeEvents = [...new Set([...settingObjectEvents, ...trackedEventsSetting])];
  const { posthog_api_key, posthog_api_host } = settings;
  if (!posthog_api_key) {
    throw new Error('ph_project_api_key is undefined');
  }
  /** Campaign params of the page the sandbox booted on. Per-event values are derived in `eventProperties`. */
  const initCampaign = calculateCampaignParams(init.context.document.location.href)
  let customerPrivacyStatus: CustomerPrivacyPayload['customerPrivacy'] = init.customerPrivacy;
  const POSTHOG_WINDOW_KEY = `ph_${posthog_api_key}_window_id`;
  const POSTHOG_KEY = `ph_${posthog_api_key}_posthog`;

  async function getPostHogLocalStorage(): Promise<string | null> { 
    const webPostHogPersistedString = await localStorage.getItem(POSTHOG_KEY);
    return webPostHogPersistedString
  }
  /** Parsed posthog-js persistence blob; a corrupt blob yields `{}` instead of throwing inside `register()`. */
  async function readPostHogLocalStorage(): Promise<Record<string, unknown>> {
    const persistedString = await getPostHogLocalStorage();
    if (!persistedString) return {};
    try {
      const parsed = JSON.parse(persistedString);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  /**
   * Merge into posthog-js's persistence blob instead of replacing it: the storefront posthog-js instance
   * keeps `$sesid`, `$initial_person_info`, feature flag payloads… under the same key.
   */
  async function mergePostHogLocalStorage(patch: Record<string, unknown>): Promise<void> {
    const persisted = await readPostHogLocalStorage();
    await localStorage.setItem(POSTHOG_KEY, JSON.stringify({ ...persisted, ...patch }));
  }
  async function resolveDistinctId(): Promise<string> {
    const webPostHogPersisted = await readPostHogLocalStorage();
    if (typeof webPostHogPersisted.distinct_id === 'string' && webPostHogPersisted.distinct_id) {
      return webPostHogPersisted.distinct_id;
    }

    const distinct_id = uuidv7();
    await mergePostHogLocalStorage({ distinct_id });
    return distinct_id;
  }

  async function getWindowId(): Promise<string | null> {
    const windowPostHogPersistedString = await sessionStorage.getItem(POSTHOG_WINDOW_KEY);
    const windowPostHogPersisted: string | null = windowPostHogPersistedString ? windowPostHogPersistedString : null;
    if(windowPostHogPersisted) {
      return windowPostHogPersisted
    }
    return null
  }

  async function getSessionId(): Promise<[number, string | null, number]> {
    const webPostHogPersistedString = await getPostHogLocalStorage()
    const webPostHogPersisted: {
      $sesid: [
        sessionActivityTimestamp: number | 0,
        sessionId: string | null,
        sessionStartTimestamp: number | 0
      ]
    } | null = webPostHogPersistedString ? JSON.parse(webPostHogPersistedString) : null;

    if(!webPostHogPersisted || !webPostHogPersisted?.$sesid ||  !webPostHogPersisted?.$sesid[0] && !webPostHogPersisted?.$sesid[1] && !webPostHogPersisted?.$sesid[2] ) {
      return [0, null, 0]
    }
    
    return webPostHogPersisted.$sesid
  }

  async function updateSessionId(sessionActivityTimestamp: number | null, sessionId: string | null, sessionStartTimestamp: number | null) {
    const webPostHogPersistedString = await getPostHogLocalStorage()
    const webPostHogPersisted: {
      $sesid: [
        sessionActivityTimestamp: number | 0,
        sessionId: string | null,
        sessionStartTimestamp: number | 0
      ]
    } | null = webPostHogPersistedString ? JSON.parse(webPostHogPersistedString) : null;

    if(webPostHogPersisted) {
      await localStorage.setItem(POSTHOG_KEY, JSON.stringify({...webPostHogPersisted,
        $sesid:[sessionActivityTimestamp,sessionId,sessionStartTimestamp]}));
    }
  }
  const MAX_SESSION_IDLE_TIMEOUT = 30 * 60; // 30 minutes
  const MIN_SESSION_IDLE_TIMEOUT = 60; // 1 minute
  const SESSION_LENGTH_LIMIT = 24 * 3600; // 24 hours

  const sessionTimeoutMs = Math.min(Math.max(MAX_SESSION_IDLE_TIMEOUT, MIN_SESSION_IDLE_TIMEOUT), MAX_SESSION_IDLE_TIMEOUT) * 1000;

  async function resolveSessionId(): Promise<{sessionId: string, windowId: string, sessionStartTimestamp: number}> {


    const timestamp = new Date().getTime();
    let [lastTimestamp, sessionId, startTimestamp] = await getSessionId();
    let windowId = await getWindowId();
    const sessionPastMaximumLength = isNumber(startTimestamp) && startTimestamp > 0 && Math.abs(timestamp - startTimestamp) > SESSION_LENGTH_LIMIT * 1000;
    
    const activityTimeout = Math.abs(timestamp - lastTimestamp) > sessionTimeoutMs;
    
    if (!sessionId || activityTimeout || sessionPastMaximumLength) {
      sessionId = uuidv7();
      windowId = uuidv7();
      startTimestamp = timestamp;
    } else if (!windowId) {
      windowId =  uuidv7();
    }
    const newTimestamp = timestamp;
    const sessionStartTimestamp = startTimestamp === 0 ? new Date().getTime() : startTimestamp;

    await sessionStorage.setItem(POSTHOG_WINDOW_KEY, windowId);
    await updateSessionId(newTimestamp,sessionId, sessionStartTimestamp);
    return {
      sessionId,
      windowId,
      sessionStartTimestamp
    }
  }

  /**
   * Full reset on the identified → anonymous flip (consent withdrawn): deliberately REPLACES the whole
   * persistence blob so `$sesid`, `$device_id`, `$user_state`… are dropped along with the distinct_id.
   * This is the pixel's `posthog.reset(true)` — do not turn it into a merge.
   */
  async function resetPosthog() {
    const distinct_id = uuidv7();
    await localStorage.setItem(POSTHOG_KEY, JSON.stringify({ distinct_id }));
  }

  const globalDistinctId = await resolveDistinctId()
  const posthog = new PixieHogPostHog(posthog_api_key, {
    host: posthog_api_host,
    persistence: 'memory',
    flushAt: 10,
    flushInterval: 100,
    bootstrap: {
      distinctId: globalDistinctId,
      isIdentifiedId: false,
    },
  });

  async function calculateFeatureFlags() {
  // if this fails we move on
    try {
      const flags =  await posthog.getFeatureFlags() || {}
      const keyedFlags = Object.entries(flags).sort((a, b) => a[0].localeCompare(b[0]))
      return {
        ...(keyedFlags.reduce((acc, [feature, variant]) => {
          acc[`$feature/${feature}`] = variant
          if (variant !== false) {
            acc['$active_feature_flags'] = acc['$active_feature_flags'] ? [...acc['$active_feature_flags'], feature] : [feature]
          }
          return acc
        }, {} as Record<string, any>))
      }
    } catch (error) {
      return {}
    }
  }
  const featureFlags = await calculateFeatureFlags();

  const anonymous: boolean = (() =>{

    if(settings.data_collection_strategy == 'anonymized') {
      return true
    }
    if(settings.data_collection_strategy == 'non-anonymized') {
      return false
    }
    if(settings.data_collection_strategy == 'non-anonymized-by-consent') {
      return  !customerPrivacyStatus.analyticsProcessingAllowed
    }
    return true
  })()

  type ValueOf<T> = T[keyof T];
  function preprocessEvent<T extends ValueOf<StandardEvents>>(fn: (t: T, u: string | undefined, p: boolean) => void) {
    return async (event: T) => {
      // if event is disabled by merchant skip
      if (settings[event.name as keyof WebPixelSettings] === 'false') {
        return;
      }
      const uuid: string | undefined = event.id;
      const validateEventUUID: string | undefined = extractEventUUID(uuid);
    
      const PXHOG_ANONYMOUS_KEY = 'pxhog_anonymous_key';

      const localStorageAnonymous = await localStorage.getItem(PXHOG_ANONYMOUS_KEY) as 'true' | 'false' | null;
      if (localStorageAnonymous === null) {
        await localStorage.setItem(PXHOG_ANONYMOUS_KEY, anonymous);
      }
      if (
        localStorageAnonymous !== null &&
        localStorageAnonymous != String(anonymous) && anonymous == true) {
        await resetPosthog();
      }
      if (
        localStorageAnonymous !== null &&
        localStorageAnonymous != String(anonymous)) {
        await localStorage.setItem(PXHOG_ANONYMOUS_KEY, anonymous);
      }
      
      fn(event, validateEventUUID, anonymous);
    };
  }

  customerPrivacy.subscribe('visitorConsentCollected', (event) => {
    customerPrivacyStatus = event.customerPrivacy;
  });
  const userAgent = (() => {
    try {
      return UAParser(init.context.navigator.userAgent);
    } catch (error) {
      return null
    }
  })();
  const currentURLObject = (() => {
    try {
      return new URL(init.context.document.location.href);
    } catch (error) {
      return null
    }
  })();
  const referringURLObject = (() => {
    try {
      if (!init?.context?.document?.referrer) {
        return null
      }
      return new URL(init.context.document.referrer);
    } catch (error) {
      return null
    }
  })();
  //https://posthog.com/docs/data/events;

  const initProperties = {
    $os: userAgent?.os.name || null,
    $os_version: userAgent?.os.version || null,
    $browser: userAgent?.browser.name || null,
    $browser_version: userAgent?.browser.version ? String(userAgent.browser.version) : null,
    $device_type: (userAgent?.device.type || null) as JsonType,
    $current_url: init.context.document.location.href,
    $host: currentURLObject?.host || null,
    $pathname: currentURLObject?.pathname || null,
    $screen_height: init.context.window.screen.height,
    $screen_width: init.context.window.screen.width,
    $viewport_height: init.context.window.innerHeight,
    $viewport_width: init.context.window.innerWidth,
    $search_engine: getSearchEngine(init?.context?.document?.referrer || null),
    $referrer: init.context.document.referrer || '$direct',
    $referring_domain: referringURLObject?.host || '$direct',
    /** how to calculate active_feature_flags */
    //$active_feature_flags: null,
    shop: init.data.shop as any,
    // Consent refused → no customer PII on events (the per-handler `customer: null` never removed these flattened keys)
    ...(anonymous ? {} : (init.data.customer as any)),
    // this might be out of date if the store uses side-cart
    ...(init.data.cart as any),
  } as const;

  /**
   * First-touch device/referrer properties for `$set_once` (boot-time snapshot).
   * Nulls are stripped in `buildEventProperties` — an explicit null in `$set_once` is permanent.
   * https://posthog.com/docs/product-analytics/person-properties
   */
  const setOnceBase = {
    $initial_browser: userAgent?.browser.name || null,
    $initial_browser_version: userAgent?.browser.version || null,
    $initial_os: userAgent?.os.name || null,
    $initial_os_version: userAgent?.os.version || null,
    $initial_device_type: userAgent?.device.type as JsonType || null,
    $initial_current_url: init.context.document.location.href,
    $initial_pathname: currentURLObject?.pathname || null,
    $initial_referrer: init.context.document.referrer || '$direct',
    $initial_referring_domain: referringURLObject?.host || '$direct',
  };

  /**
   * Properties for one event: boot-time base + campaign params from the event's own URL + person
   * properties (only when not anonymous). `name` is required in the type so DOM events — which have no
   * `context` at all — still satisfy it (TS weak-type check).
   */
  const eventProperties = (event: { name: string; context?: Context }, anonymous: boolean) =>
    buildEventProperties({
      base: initProperties,
      customer: init.data.customer as Record<string, unknown> | null | undefined,
      initCampaign,
      eventHref: event.context?.document?.location?.href,
      anonymous,
      setOnceBase,
    });

  const setDistinctId = (str: string) => mergePostHogLocalStorage({ distinct_id: str });

  if (init.data.customer?.email && anonymous == false && globalDistinctId != init.data.customer.email) {
    await setDistinctId(init.data.customer?.email)
    await posthog.identify(init.data.customer?.email)
  }

  const resolveEventEcommerceName = (name: string) => {
    if (!posthogEcommerceSpecEnabled) {
      return name
    }
    const mapped = webPixelToPostHogEcommerceSpecMap[name]
    if (!mapped) {
      return name;
    }
    return mapped
  }

  const resolveEventEcommerceSpecBody = (event: PixelEvents[keyof PixelEvents]) => {
    if (!posthogEcommerceSpecEnabled) {
      return {};
    }
    const transformer = webPixelToPostHogEcommerceSpecTransformerMap[event.name]
    if (!transformer) {
      return {}
    }
    const transformed = transformer(init.data.shop, event)

    return transformed;

  }

  const checkoutKeys = [
    'checkout_started',
    'checkout_completed',
    'checkout_shipping_info_submitted',
    'checkout_contact_info_submitted',
    'checkout_address_info_submitted',
    'payment_info_submitted',
  ] as const;

  
  const trackedCheckoutKeys = checkoutKeys.filter((key) => activeEvents.includes(key));
  for (const key of trackedCheckoutKeys) {
    analytics.subscribe(
      key,
      preprocessEvent(async (event, uuid, anonymous) => {
        const distinctId = await resolveDistinctId();
        const {sessionId,windowId} = await resolveSessionId();
        const eventName = resolveEventEcommerceName(event.name);

        const dedupUUID = uuid;

        await posthog.captureStatelessPublic(distinctId, eventName, {
          ...featureFlags,
          ...eventProperties(event, anonymous),
          ...(anonymous == true && {
            customer: null,
            purchasingCompany: null,
          }),
          cart: null,
          client_id: event.clientId,
          url: event.context.document.location.href,
          $current_url: event.context.document.location.href,
          $session_id : sessionId,
          $configured_session_timeout_ms: sessionTimeoutMs,
          $window_id: windowId,
          ...(event.data.checkout as any),
            ...(anonymous == true && {
              billingAddress: null,
              email: null,
              order: {
                ...(event.data.checkout.order as unknown as any),
                customer: {
                  ...(event.data.checkout.order?.customer as unknown as any),
                  id: null,
                },
                id: null,
              },
              phone: null,
              shippingAddress: null,
              smsMarketingPhone: null,
            }),
          ...resolveEventEcommerceSpecBody(event)
        }, {
          ...(dedupUUID ? { uuid: dedupUUID } : {}),
          timestamp: new Date(event.timestamp),
        });

        const email = event.data.checkout.email
        if (email && anonymous == false && distinctId != email) {
          await setDistinctId(email)
          await posthog.identify(email)
        }
      
      })
    );
  }

  const productCartKeys = ['product_added_to_cart', 'product_removed_from_cart'] as const;
  const trackedProductCartKeys = productCartKeys.filter((key) => activeEvents.includes(key));
  for (const key of trackedProductCartKeys ) {
    analytics.subscribe(
      key,
      preprocessEvent(async (event, uuid, anonymous) => {
        const distinctId = await resolveDistinctId();
        const {sessionId,windowId} = await resolveSessionId()
        const eventName = resolveEventEcommerceName(event.name);
        posthog.captureStatelessPublic(distinctId, eventName, 
          {
            ...featureFlags,
            ...eventProperties(event, anonymous),
            ...(anonymous == true && {
              customer: undefined,
              purchasingCompany: undefined,
            }),
            client_id: event.clientId,
            url: event.context.document.location.href,
            $current_url: event.context.document.location.href,
            $session_id : sessionId,
            $configured_session_timeout_ms: sessionTimeoutMs,
            $window_id: windowId,
            ...(event.data.cartLine && {
                ...(event.data.cartLine.merchandise as unknown as any),
                cost: event.data.cartLine.cost.totalAmount.amount,
                quantity: event.data.cartLine.quantity,
            }),
            ...resolveEventEcommerceSpecBody(event)
          }, {
          ...(uuid ? { uuid: uuid } : {}),
          timestamp: new Date(event.timestamp),
        });
      })
    );
  }

  const mouseEventsKeys = ['clicked', 'input_blurred', 'input_changed'] as const;
  const trackedMouseEventsKeys = mouseEventsKeys.filter((key) => activeEvents.includes(key));
  for (const key of trackedMouseEventsKeys) {
    analytics.subscribe(
      key,
      preprocessEvent(async (event, uuid, anonymous) => {
        // DOM events do not have window/document context
        // cannot set URL
        const distinctId = await resolveDistinctId();
        const {sessionId,windowId} = await resolveSessionId()
        const eventName = resolveEventEcommerceName(event.name)
        posthog.captureStatelessPublic( distinctId, eventName,{
          ...featureFlags,
          $session_id : sessionId,
          $configured_session_timeout_ms: sessionTimeoutMs,
          $window_id: windowId,
          ...{
            ...eventProperties(event, anonymous),
            ...(anonymous == true && {
              customer: undefined,
              purchasingCompany: undefined,
            }),
          },
          client_id: event.clientId,
          ...event.data.element as any,
          ...resolveEventEcommerceSpecBody(event)
        }, {
          ...(uuid ? { uuid: uuid } : {}),
          timestamp: new Date(event.timestamp),
        });
      })
    );
  }

  activeEvents.includes('page_viewed') && analytics.subscribe(
    'page_viewed',
    preprocessEvent(async (event, uuid, anonymous) => {
      const distinctId = await resolveDistinctId();
      const {sessionId,windowId} = await resolveSessionId()
      const eventName = resolveEventEcommerceName(event.name);
      posthog.captureStatelessPublic(distinctId, eventName, {
        ...featureFlags,
        ...eventProperties(event, anonymous),
        ...(anonymous == true && {
          customer: null,
          purchasingCompany: null,
          $process_person_profile: false,
        }),
        client_id: event.clientId,
        url: event.context.document.location.href,
        $current_url: event.context.document.location.href,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...event.data,
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),
        ...(uuid ? { uuid: uuid } : {}),
      });
    })
  );

  activeEvents.includes('collection_viewed') && analytics.subscribe(
    'collection_viewed',
    preprocessEvent(async (event, uuid, anonymous) => {
      const distinctId = await resolveDistinctId();
      const {sessionId,windowId} = await resolveSessionId()
      const eventName = resolveEventEcommerceName(event.name)
      posthog.captureStatelessPublic(distinctId, eventName,{
        ...featureFlags,
        ...eventProperties(event, anonymous),
        ...(anonymous == true && {
          customer: undefined,
          purchasingCompany: undefined,
        }),
        client_id: event.clientId,
        url: event.context.document.location.href,
        $current_url: event.context.document.location.href,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...event.data.collection as any,
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),
        ...(uuid ? { uuid: uuid } : {}),
      });
    })
  );

  activeEvents.includes('product_viewed') && analytics.subscribe(
    'product_viewed',
    preprocessEvent(async (event, uuid, anonymous) => {
      const distinctId = await resolveDistinctId();
      const {sessionId,windowId} = await resolveSessionId()
      const eventName = resolveEventEcommerceName(event.name)
      posthog.captureStatelessPublic(distinctId, eventName, {
        ...featureFlags,
        ...eventProperties(event, anonymous),
        ...(anonymous == true && {
          customer: undefined,
          purchasingCompany: undefined,
        }),
        client_id: event.clientId,
        url: event.context.document.location.href,
        $current_url: event.context.document.location.href,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...event.data.productVariant as any,
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),
        ...(uuid ? { uuid: uuid } : {}),

      });
    })
  );

  activeEvents.includes('cart_viewed') && analytics.subscribe(
    'cart_viewed',
    preprocessEvent(async (event, uuid, anonymous) => {
      const distinctId = await resolveDistinctId();
      const {sessionId,windowId} = await resolveSessionId()
      const eventName = resolveEventEcommerceName(event.name);
      posthog.captureStatelessPublic(distinctId, eventName, {
        ...featureFlags,
        ...{
          ...eventProperties(event, anonymous),
          ...(anonymous == true && {
            customer: undefined,
            purchasingCompany: undefined,
          }),
          cart: undefined,
        },
        client_id: event.clientId,
        url: event.context.document.location.href,
        $current_url: event.context.document.location.href,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...event.data.cart as any,
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),
        ...(uuid ? { uuid: uuid } : {}),
      });
    })
  );

  activeEvents.includes('search_submitted') && analytics.subscribe(
    'search_submitted',
    preprocessEvent(async (event, uuid, anonymous) => {
      
      const distinctId = await resolveDistinctId();
      const {sessionId,windowId} = await resolveSessionId()
      const eventName = resolveEventEcommerceName(event.name);
      posthog.captureStatelessPublic(distinctId, eventName,{
        ...featureFlags,
          ...eventProperties(event, anonymous),
          ...(anonymous == true && {
            customer: undefined,
            purchasingCompany: undefined,
          }),
        client_id: event.clientId,
        url: event.context.document.location.href,
        $current_url: event.context.document.location.href,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...event.data.searchResult as any,
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),

        ...(uuid ? { uuid: uuid } : {}),

      });
    })
  );

  activeEvents.includes('form_submitted') && analytics.subscribe(
    'form_submitted',
    preprocessEvent(async (event, uuid, anonymous) => {
      const distinctId = await resolveDistinctId();
      const eventName = resolveEventEcommerceName(event.name);
      const {sessionId,windowId} = await resolveSessionId()
      const emailRegex = /email/i;
      const [email] = event.data.element.elements
        .filter((item) => emailRegex.test(item.id || '') || emailRegex.test(item.name || ''))
        .map((item) => item.value);

      const formBody = Object.fromEntries(
        event.data.element.elements
          .map<[string, string] | undefined>(({ name, value }) => {
            // inputs with no name will be ignored
            if (!name) {
              return undefined;
            }
            return [name, value || ''] as [string, string];
          })
          .filter((el): el is [string, string] => !!el)
      );
      const baseProperties = eventProperties(event, anonymous);
      await posthog.captureStatelessPublic(distinctId, eventName, {
        ...featureFlags,
        $session_id : sessionId,
        $configured_session_timeout_ms: sessionTimeoutMs,
        $window_id: windowId,
        ...baseProperties,
        ...(anonymous == true && {
          customer: null,
          purchasingCompany: null,
        }),
        client_id: event.clientId,
        form: event.data.element.elements as any,
        form_body: formBody as any,
        action: event.data.element.action as any,
        ...(email &&
          anonymous == false && {
            $set: {
              ...(baseProperties.$set as Record<string, unknown> | undefined),
              email: email,
            },
          }),
        ...resolveEventEcommerceSpecBody(event)
      }, {
        timestamp: new Date(event.timestamp),
        ...(uuid ? { uuid: uuid } : {}), 
      });
      if (email && anonymous == false && distinctId != email) {
        await setDistinctId(email)
        await posthog.identify(email)
      }
    })

    
  );
});
