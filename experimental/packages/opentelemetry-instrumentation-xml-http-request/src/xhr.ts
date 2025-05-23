/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '@opentelemetry/api';
import {
  SemconvStability,
  semconvStabilityFromStr,
  isWrapped,
  InstrumentationBase,
  InstrumentationConfig,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import { hrTime, isUrlIgnored, otperformance } from '@opentelemetry/core';
import {
  addSpanNetworkEvents,
  getResource,
  PerformanceTimingNames as PTN,
  shouldPropagateTraceHeaders,
  parseUrl,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';
import {
  ATTR_HTTP_HOST,
  ATTR_HTTP_METHOD,
  ATTR_HTTP_SCHEME,
  ATTR_HTTP_STATUS_CODE,
  ATTR_HTTP_URL,
  ATTR_HTTP_USER_AGENT,
  ATTR_HTTP_REQUEST_BODY_SIZE,
  ATTR_HTTP_REQUEST_CONTENT_LENGTH_UNCOMPRESSED,
} from './semconv';
import { EventNames } from './enums/EventNames';
import {
  OpenFunction,
  PropagateTraceHeaderCorsUrls,
  SendFunction,
  XhrMem,
} from './types';
import {
  normalizeHttpRequestMethod,
  serverPortFromUrl,
  getXHRBodyLength,
} from './utils';
import { VERSION } from './version';
import { AttributeNames } from './enums/AttributeNames';

// how long to wait for observer to collect information about resources
// this is needed as event "load" is called before observer
// hard to say how long it should really wait, seems like 300ms is
// safe enough
const OBSERVER_WAIT_TIME_MS = 300;

export type XHRCustomAttributeFunction = (
  span: api.Span,
  xhr: XMLHttpRequest
) => void;

/**
 * XMLHttpRequest config
 */
export interface XMLHttpRequestInstrumentationConfig
  extends InstrumentationConfig {
  /**
   * The number of timing resources is limited, after the limit
   * (chrome 250, safari 150) the information is not collected anymore.
   * The only way to prevent that is to regularly clean the resources
   * whenever it is possible. This is needed only when PerformanceObserver
   * is not available
   */
  clearTimingResources?: boolean;
  /** URLs which should include trace headers when origin doesn't match */
  propagateTraceHeaderCorsUrls?: PropagateTraceHeaderCorsUrls;
  /**
   * URLs that partially match any regex in ignoreUrls will not be traced.
   * In addition, URLs that are _exact matches_ of strings in ignoreUrls will
   * also not be traced.
   */
  ignoreUrls?: Array<string | RegExp>;
  /** Function for adding custom attributes on the span */
  applyCustomAttributesOnSpan?: XHRCustomAttributeFunction;
  /** Ignore adding network events as span events */
  ignoreNetworkEvents?: boolean;
  /** Measure outgoing request size */
  measureRequestSize?: boolean;
  /** Select the HTTP semantic conventions version(s) used. */
  semconvStabilityOptIn?: string;
}

/**
 * This class represents a XMLHttpRequest plugin for auto instrumentation
 */
export class XMLHttpRequestInstrumentation extends InstrumentationBase<XMLHttpRequestInstrumentationConfig> {
  readonly component: string = 'xml-http-request';
  readonly version: string = VERSION;
  moduleName = this.component;

  private _tasksCount = 0;
  private _xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();
  private _usedResources = new WeakSet<PerformanceResourceTiming>();
  private _semconvStability: SemconvStability;

  constructor(config: XMLHttpRequestInstrumentationConfig = {}) {
    super('@opentelemetry/instrumentation-xml-http-request', VERSION, config);
    this._semconvStability = semconvStabilityFromStr(
      'http',
      config?.semconvStabilityOptIn
    );
  }

  init() {}

  /**
   * Adds custom headers to XMLHttpRequest
   * @param xhr
   * @param spanUrl
   * @private
   */
  private _addHeaders(xhr: XMLHttpRequest, spanUrl: string) {
    const url = parseUrl(spanUrl).href;
    if (
      !shouldPropagateTraceHeaders(
        url,
        this.getConfig().propagateTraceHeaderCorsUrls
      )
    ) {
      const headers: Partial<Record<string, unknown>> = {};
      api.propagation.inject(api.context.active(), headers);
      if (Object.keys(headers).length > 0) {
        this._diag.debug('headers inject skipped due to CORS policy');
      }
      return;
    }
    const headers: { [key: string]: unknown } = {};
    api.propagation.inject(api.context.active(), headers);
    Object.keys(headers).forEach(key => {
      xhr.setRequestHeader(key, String(headers[key]));
    });
  }

  /**
   * Add cors pre flight child span
   * @param span
   * @param corsPreFlightRequest
   * @private
   */
  private _addChildSpan(
    span: api.Span,
    corsPreFlightRequest: PerformanceResourceTiming
  ): void {
    api.context.with(api.trace.setSpan(api.context.active(), span), () => {
      const childSpan = this.tracer.startSpan('CORS Preflight', {
        startTime: corsPreFlightRequest[PTN.FETCH_START],
      });
      const skipOldSemconvContentLengthAttrs = !(
        this._semconvStability & SemconvStability.OLD
      );
      addSpanNetworkEvents(
        childSpan,
        corsPreFlightRequest,
        this.getConfig().ignoreNetworkEvents,
        undefined,
        skipOldSemconvContentLengthAttrs
      );
      childSpan.end(corsPreFlightRequest[PTN.RESPONSE_END]);
    });
  }

  /**
   * Add attributes when span is going to end
   * @param span
   * @param xhr
   * @param spanUrl
   * @private
   */
  _addFinalSpanAttributes(span: api.Span, xhrMem: XhrMem, spanUrl?: string) {
    if (this._semconvStability & SemconvStability.OLD) {
      if (xhrMem.status !== undefined) {
        span.setAttribute(ATTR_HTTP_STATUS_CODE, xhrMem.status);
      }
      if (xhrMem.statusText !== undefined) {
        span.setAttribute(AttributeNames.HTTP_STATUS_TEXT, xhrMem.statusText);
      }
      if (typeof spanUrl === 'string') {
        const parsedUrl = parseUrl(spanUrl);
        span.setAttribute(ATTR_HTTP_HOST, parsedUrl.host);
        span.setAttribute(
          ATTR_HTTP_SCHEME,
          parsedUrl.protocol.replace(':', '')
        );
      }

      // @TODO do we want to collect this or it will be collected earlier once only or
      //    maybe when parent span is not available ?
      span.setAttribute(ATTR_HTTP_USER_AGENT, navigator.userAgent);
    }
    if (this._semconvStability & SemconvStability.STABLE) {
      if (xhrMem.status) {
        // Intentionally exclude status=0, because XHR uses 0 for before a
        // response is received and semconv says to only add the attribute if
        // received a response.
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, xhrMem.status);
      }
    }
  }

  private _applyAttributesAfterXHR(span: api.Span, xhr: XMLHttpRequest) {
    const applyCustomAttributesOnSpan =
      this.getConfig().applyCustomAttributesOnSpan;
    if (typeof applyCustomAttributesOnSpan === 'function') {
      safeExecuteInTheMiddle(
        () => applyCustomAttributesOnSpan(span, xhr),
        error => {
          if (!error) {
            return;
          }

          this._diag.error('applyCustomAttributesOnSpan', error);
        },
        true
      );
    }
  }

  /**
   * will collect information about all resources created
   * between "send" and "end" with additional waiting for main resource
   * @param xhr
   * @param spanUrl
   * @private
   */
  private _addResourceObserver(xhr: XMLHttpRequest, spanUrl: string) {
    const xhrMem = this._xhrMem.get(xhr);
    if (
      !xhrMem ||
      typeof PerformanceObserver !== 'function' ||
      typeof PerformanceResourceTiming !== 'function'
    ) {
      return;
    }
    xhrMem.createdResources = {
      observer: new PerformanceObserver(list => {
        const entries = list.getEntries() as PerformanceResourceTiming[];
        const parsedUrl = parseUrl(spanUrl);

        entries.forEach(entry => {
          if (
            entry.initiatorType === 'xmlhttprequest' &&
            entry.name === parsedUrl.href
          ) {
            if (xhrMem.createdResources) {
              xhrMem.createdResources.entries.push(entry);
            }
          }
        });
      }),
      entries: [],
    };
    xhrMem.createdResources.observer.observe({
      entryTypes: ['resource'],
    });
  }

  /**
   * Clears the resource timings and all resources assigned with spans
   *     when {@link XMLHttpRequestInstrumentationConfig.clearTimingResources} is
   *     set to true (default false)
   * @private
   */
  private _clearResources() {
    if (this._tasksCount === 0 && this.getConfig().clearTimingResources) {
      (otperformance as unknown as Performance).clearResourceTimings();
      this._xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();
      this._usedResources = new WeakSet<PerformanceResourceTiming>();
    }
  }

  /**
   * Finds appropriate resource and add network events to the span
   * @param span
   */
  private _findResourceAndAddNetworkEvents(
    xhrMem: XhrMem,
    span: api.Span,
    spanUrl?: string,
    startTime?: api.HrTime,
    endTime?: api.HrTime
  ): void {
    if (!spanUrl || !startTime || !endTime || !xhrMem.createdResources) {
      return;
    }

    let resources: PerformanceResourceTiming[] =
      xhrMem.createdResources.entries;

    if (!resources || !resources.length) {
      // fallback - either Observer is not available or it took longer
      // then OBSERVER_WAIT_TIME_MS and observer didn't collect enough
      // information
      // ts thinks this is the perf_hooks module, but it is the browser performance api
      resources = (otperformance as unknown as Performance).getEntriesByType(
        'resource'
      ) as PerformanceResourceTiming[];
    }

    const resource = getResource(
      parseUrl(spanUrl).href,
      startTime,
      endTime,
      resources,
      this._usedResources
    );

    if (resource.mainRequest) {
      const mainRequest = resource.mainRequest;
      this._markResourceAsUsed(mainRequest);

      const corsPreFlightRequest = resource.corsPreFlightRequest;
      if (corsPreFlightRequest) {
        this._addChildSpan(span, corsPreFlightRequest);
        this._markResourceAsUsed(corsPreFlightRequest);
      }
      const skipOldSemconvContentLengthAttrs = !(
        this._semconvStability & SemconvStability.OLD
      );
      addSpanNetworkEvents(
        span,
        mainRequest,
        this.getConfig().ignoreNetworkEvents,
        undefined,
        skipOldSemconvContentLengthAttrs
      );
    }
  }

  /**
   * Removes the previous information about span.
   * This might happened when the same xhr is used again.
   * @param xhr
   * @private
   */
  private _cleanPreviousSpanInformation(xhr: XMLHttpRequest) {
    const xhrMem = this._xhrMem.get(xhr);
    if (xhrMem) {
      const callbackToRemoveEvents = xhrMem.callbackToRemoveEvents;
      if (callbackToRemoveEvents) {
        callbackToRemoveEvents();
      }
      this._xhrMem.delete(xhr);
    }
  }

  /**
   * Creates a new span when method "open" is called
   * @param xhr
   * @param url
   * @param method
   * @private
   */
  private _createSpan(
    xhr: XMLHttpRequest,
    url: string,
    method: string
  ): api.Span | undefined {
    if (isUrlIgnored(url, this.getConfig().ignoreUrls)) {
      this._diag.debug('ignoring span as url matches ignored url');
      return;
    }

    let name = '';
    const parsedUrl = parseUrl(url);
    const attributes = {} as api.Attributes;
    if (this._semconvStability & SemconvStability.OLD) {
      name = method.toUpperCase();
      attributes[ATTR_HTTP_METHOD] = method;
      attributes[ATTR_HTTP_URL] = parsedUrl.toString();
    }
    if (this._semconvStability & SemconvStability.STABLE) {
      const origMethod = method;
      const normMethod = normalizeHttpRequestMethod(method);
      if (!name) {
        // The "old" span name wins if emitting both old and stable semconv
        // ('http/dup').
        name = normMethod;
      }
      attributes[ATTR_HTTP_REQUEST_METHOD] = normMethod;
      if (normMethod !== origMethod) {
        attributes[ATTR_HTTP_REQUEST_METHOD_ORIGINAL] = origMethod;
      }
      attributes[ATTR_URL_FULL] = parsedUrl.toString();
      attributes[ATTR_SERVER_ADDRESS] = parsedUrl.hostname;
      const serverPort = serverPortFromUrl(parsedUrl);
      if (serverPort) {
        attributes[ATTR_SERVER_PORT] = serverPort;
      }
    }

    const currentSpan = this.tracer.startSpan(name, {
      kind: api.SpanKind.CLIENT,
      attributes,
    });

    currentSpan.addEvent(EventNames.METHOD_OPEN);

    this._cleanPreviousSpanInformation(xhr);

    this._xhrMem.set(xhr, {
      span: currentSpan,
      spanUrl: url,
    });

    return currentSpan;
  }

  /**
   * Marks certain [resource]{@link PerformanceResourceTiming} when information
   * from this is used to add events to span.
   * This is done to avoid reusing the same resource again for next span
   * @param resource
   * @private
   */
  private _markResourceAsUsed(resource: PerformanceResourceTiming) {
    this._usedResources.add(resource);
  }

  /**
   * Patches the method open
   * @private
   */
  protected _patchOpen() {
    return (original: OpenFunction): OpenFunction => {
      const plugin = this;
      return function patchOpen(this: XMLHttpRequest, ...args): void {
        const method: string = args[0];
        const url: string = args[1];
        plugin._createSpan(this, url, method);

        return original.apply(this, args);
      };
    };
  }

  /**
   * Patches the method send
   * @private
   */
  protected _patchSend() {
    const plugin = this;

    function endSpanTimeout(
      eventName: string,
      xhrMem: XhrMem,
      performanceEndTime: api.HrTime,
      endTime: number
    ) {
      const callbackToRemoveEvents = xhrMem.callbackToRemoveEvents;

      if (typeof callbackToRemoveEvents === 'function') {
        callbackToRemoveEvents();
      }

      const { span, spanUrl, sendStartTime } = xhrMem;

      if (span) {
        plugin._findResourceAndAddNetworkEvents(
          xhrMem,
          span,
          spanUrl,
          sendStartTime,
          performanceEndTime
        );
        span.addEvent(eventName, endTime);
        plugin._addFinalSpanAttributes(span, xhrMem, spanUrl);
        span.end(endTime);
        plugin._tasksCount--;
      }
      plugin._clearResources();
    }

    function endSpan(
      eventName: string,
      xhr: XMLHttpRequest,
      isError: boolean,
      errorType?: string
    ) {
      const xhrMem = plugin._xhrMem.get(xhr);
      if (!xhrMem) {
        return;
      }
      xhrMem.status = xhr.status;
      xhrMem.statusText = xhr.statusText;
      plugin._xhrMem.delete(xhr);

      if (xhrMem.span) {
        const span = xhrMem.span;
        plugin._applyAttributesAfterXHR(span, xhr);

        if (plugin._semconvStability & SemconvStability.STABLE) {
          if (isError) {
            if (errorType) {
              span.setStatus({
                code: api.SpanStatusCode.ERROR,
                message: errorType,
              });
              span.setAttribute(ATTR_ERROR_TYPE, errorType);
            }
          } else if (xhrMem.status && xhrMem.status >= 400) {
            span.setStatus({ code: api.SpanStatusCode.ERROR });
            span.setAttribute(ATTR_ERROR_TYPE, String(xhrMem.status));
          }
        }
      }

      const performanceEndTime = hrTime();
      const endTime = Date.now();

      // the timeout is needed as observer doesn't have yet information
      // when event "load" is called. Also the time may differ depends on
      // browser and speed of computer
      setTimeout(() => {
        endSpanTimeout(eventName, xhrMem, performanceEndTime, endTime);
      }, OBSERVER_WAIT_TIME_MS);
    }

    function onError(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_ERROR, this, true, 'error');
    }

    function onAbort(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_ABORT, this, false);
    }

    function onTimeout(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_TIMEOUT, this, true, 'timeout');
    }

    function onLoad(this: XMLHttpRequest) {
      if (this.status < 299) {
        endSpan(EventNames.EVENT_LOAD, this, false);
      } else {
        endSpan(EventNames.EVENT_ERROR, this, false);
      }
    }

    function unregister(xhr: XMLHttpRequest) {
      xhr.removeEventListener('abort', onAbort);
      xhr.removeEventListener('error', onError);
      xhr.removeEventListener('load', onLoad);
      xhr.removeEventListener('timeout', onTimeout);
      const xhrMem = plugin._xhrMem.get(xhr);
      if (xhrMem) {
        xhrMem.callbackToRemoveEvents = undefined;
      }
    }

    return (original: SendFunction): SendFunction => {
      return function patchSend(this: XMLHttpRequest, ...args): void {
        const xhrMem = plugin._xhrMem.get(this);
        if (!xhrMem) {
          return original.apply(this, args);
        }
        const currentSpan = xhrMem.span;
        const spanUrl = xhrMem.spanUrl;

        if (currentSpan && spanUrl) {
          if (plugin.getConfig().measureRequestSize && args?.[0]) {
            const body = args[0];
            const bodyLength = getXHRBodyLength(body);
            if (bodyLength !== undefined) {
              if (plugin._semconvStability & SemconvStability.OLD) {
                currentSpan.setAttribute(
                  ATTR_HTTP_REQUEST_CONTENT_LENGTH_UNCOMPRESSED,
                  bodyLength
                );
              }
              if (plugin._semconvStability & SemconvStability.STABLE) {
                currentSpan.setAttribute(
                  ATTR_HTTP_REQUEST_BODY_SIZE,
                  bodyLength
                );
              }
            }
          }

          api.context.with(
            api.trace.setSpan(api.context.active(), currentSpan),
            () => {
              plugin._tasksCount++;
              xhrMem.sendStartTime = hrTime();
              currentSpan.addEvent(EventNames.METHOD_SEND);

              this.addEventListener('abort', onAbort);
              this.addEventListener('error', onError);
              this.addEventListener('load', onLoad);
              this.addEventListener('timeout', onTimeout);

              xhrMem.callbackToRemoveEvents = () => {
                unregister(this);
                if (xhrMem.createdResources) {
                  xhrMem.createdResources.observer.disconnect();
                }
              };
              plugin._addHeaders(this, spanUrl);
              plugin._addResourceObserver(this, spanUrl);
            }
          );
        }
        return original.apply(this, args);
      };
    };
  }

  /**
   * implements enable function
   */
  override enable() {
    this._diag.debug('applying patch to', this.moduleName, this.version);

    if (isWrapped(XMLHttpRequest.prototype.open)) {
      this._unwrap(XMLHttpRequest.prototype, 'open');
      this._diag.debug('removing previous patch from method open');
    }

    if (isWrapped(XMLHttpRequest.prototype.send)) {
      this._unwrap(XMLHttpRequest.prototype, 'send');
      this._diag.debug('removing previous patch from method send');
    }

    this._wrap(XMLHttpRequest.prototype, 'open', this._patchOpen());
    this._wrap(XMLHttpRequest.prototype, 'send', this._patchSend());
  }

  /**
   * implements disable function
   */
  override disable() {
    this._diag.debug('removing patch from', this.moduleName, this.version);

    this._unwrap(XMLHttpRequest.prototype, 'open');
    this._unwrap(XMLHttpRequest.prototype, 'send');

    this._tasksCount = 0;
    this._xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();
    this._usedResources = new WeakSet<PerformanceResourceTiming>();
  }
}
