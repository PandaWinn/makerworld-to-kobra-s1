// Runs in MAIN world — wraps window.fetch to intercept MakerWorld's own
// authenticated f3mf download requests so we inherit auth for free.

console.log('[KS1 injected] loaded');

window.__ks1ModeActive = false;
window.__ks1Capturing  = false;

// Incremented whenever a capture is started or cancelled.
// Async responses from an older capture must never satisfy a newer one.
let ks1CaptureGeneration = 0;

const _baseFetch = window.fetch;
window.fetch = function (url, opts) {
  const p = _baseFetch.apply(this, arguments);
  if (typeof url === 'string' && url.includes('f3mf') && window.__ks1Capturing) {
    const captureGeneration =
      ks1CaptureGeneration;

    window.__ks1Capturing = false;

    console.log('[KS1 injected] intercepted f3mf fetch:', url);

    p.then(async (resp) => {
      if (
        captureGeneration !==
        ks1CaptureGeneration
      ) {
        return;
      }
      console.log('[KS1 injected] f3mf status:', resp.status);
      if (!resp.ok) {
        window.dispatchEvent(
          new CustomEvent(
            '__ks1_3mf_err',
            {
              detail:
                JSON.stringify({
                  captureTransport:
                    'fetch',

                  errorType:
                    'http',

                  httpStatus:
                    resp.status,

                  responseType:
                    String(
                      resp.type ||
                      'fetch-response'
                    ),

                  requestUrl:
                    String(url || ''),
                }),
            }
          )
        );

        return;
      }
      // Clone before MakerWorld reads the original body
      const buffer  = await resp.clone().arrayBuffer();

      if (
        captureGeneration !==
        ks1CaptureGeneration
      ) {
        return;
      }

      const blobUrl = URL.createObjectURL(
        new Blob([buffer], { type: 'application/octet-stream' })
      );
      console.log('[KS1 injected] dispatching __ks1_3mf');

      window.dispatchEvent(
        new CustomEvent(
          '__ks1_3mf',
          {
            detail:
              JSON.stringify({
                blobUrl,

                requestUrl:
                  String(url || ''),

                captureTransport:
                  'fetch',

                httpStatus:
                  resp.status,

                responseType:
                  String(
                    resp.type ||
                    'fetch-response'
                  ),
              }),
          }
        )
      );
    }).catch((err) => {
      if (
        captureGeneration !==
        ks1CaptureGeneration
      ) {
        return;
      }

      console.error(
        '[KS1 injected] capture error:',
        err
      );

      window.dispatchEvent(
        new CustomEvent(
          '__ks1_3mf_err',
          {
            detail:
              JSON.stringify({
                captureTransport:
                  'fetch',

                errorType:
                  'capture',

                requestUrl:
                  String(url || ''),

                message:
                  err instanceof Error
                    ? err.message
                    : String(err),
              }),
          }
        )
      );
    });
  }
  return p;
};

// MakerWorld may use XMLHttpRequest instead of fetch for the authenticated
// /f3mf request. Capture that response as well and pass it through the same
// __ks1_3mf event used by the existing fetch interceptor.
//
// Important:
// The /f3mf response is MakerWorld's small JSON response containing the
// filename and signed CDN URL. content.js already parses this response and
// downloads the actual 3MF from the CDN afterwards.
const ks1XhrRequestUrls =
  new WeakMap();

const ks1OriginalXhrOpen =
  XMLHttpRequest.prototype.open;

const ks1OriginalXhrSend =
  XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open =
  function (
    method,
    url
  ) {
    const result =
      ks1OriginalXhrOpen.apply(
        this,
        arguments
      );

    ks1XhrRequestUrls.set(
      this,
      String(url || '')
    );

    return result;
  };

XMLHttpRequest.prototype.send =
  function () {
    const requestUrl =
      ks1XhrRequestUrls.get(this) || '';

    // Leave every unrelated XHR completely untouched.
    if (
      !window.__ks1Capturing ||
      !requestUrl.includes('f3mf')
    ) {
      return ks1OriginalXhrSend.apply(
        this,
        arguments
      );
    }

    const captureGeneration =
      ks1CaptureGeneration;

    const onLoadEnd =
      async () => {
        // The conversion may have timed out/cancelled while this request
        // was running, or a newer capture may already have started.
        if (
          !window.__ks1Capturing ||
          captureGeneration !==
            ks1CaptureGeneration
        ) {
          return;
        }

        // Claim this response so another matching request cannot satisfy
        // the same conversion.
        window.__ks1Capturing =
          false;

        if (
          this.status < 200 ||
          this.status >= 300
        ) {
          
          window.dispatchEvent(
            new CustomEvent(
              '__ks1_3mf_err',
              {
                detail:
                  JSON.stringify({
                    captureTransport:
                      'XMLHttpRequest',

                    errorType:
                      'http',

                    httpStatus:
                      this.status,

                    responseType:
                      String(
                        this.responseType ||
                          'text'
                      ),

                    requestUrl:
                      String(
                        requestUrl ||
                          ''
                      ),
                  }),
              }
            )
          );

          return;
        }

        try {
          let buffer;

          if (
            this.responseType ===
            'blob'
          ) {
            buffer =
              await this.response.arrayBuffer();
          } else if (
            this.responseType ===
            'arraybuffer'
          ) {
            buffer =
              this.response;
          } else if (
            this.responseType ===
            'json'
          ) {
            buffer =
              JSON.stringify(
                this.response
              );
          } else {
            buffer =
              this.responseText;
          }

          // Blob conversion above is asynchronous. A cancellation or a
          // newer capture may have happened while we were awaiting it.
          if (
            captureGeneration !==
              ks1CaptureGeneration
          ) {
            return;
          }

          const blobUrl =
            URL.createObjectURL(
              new Blob(
                [buffer],
                {
                  type:
                    'application/octet-stream',
                }
              )
            );

          console.groupCollapsed(
            '[KS1 Download Capture] XMLHttpRequest · ' +
            `${this.status} · captured`
          );

          console.log(
            'Request URL:',
            requestUrl
          );

          console.log(
            'Transport:',
            'XMLHttpRequest'
          );

          console.log(
            'HTTP status:',
            this.status
          );

          console.log(
            'Response type:',
            this.responseType ||
              'text'
          );

          console.log(
            'Result:',
            'dispatched __ks1_3mf'
          );

          console.groupEnd();

          window.dispatchEvent(
            new CustomEvent(
              '__ks1_3mf',
              {
                detail:
                  JSON.stringify({
                    blobUrl,

                    requestUrl:
                      String(
                        requestUrl ||
                          ''
                      ),

                    captureTransport:
                      'XMLHttpRequest',

                    httpStatus:
                      this.status,

                    responseType:
                      String(
                        this.responseType ||
                          'text'
                      ),
                  }),
              }
            )
          );
        } catch (err) {
          if (
            captureGeneration !==
              ks1CaptureGeneration
          ) {
            return;
          }

          console.error(
            '[KS1 injected] XHR capture error:',
            err
          );

          window.dispatchEvent(
            new CustomEvent(
              '__ks1_3mf_err',
              {
                detail:
                  JSON.stringify({
                    captureTransport:
                      'XMLHttpRequest',

                    errorType:
                      'capture',

                    httpStatus:
                      this.status,

                    responseType:
                      String(
                        this.responseType ||
                          'text'
                      ),

                    requestUrl:
                      String(
                        requestUrl ||
                          ''
                      ),

                    message:
                      err instanceof Error
                        ? err.message
                        : String(err),
                  }),
              }
            )
          );
        }
      };

    this.addEventListener(
      'loadend',
      onLoadEnd,
      {
        once:
          true,
      }
    );

    try {
      return ks1OriginalXhrSend.apply(
        this,
        arguments
      );
    } catch (err) {
      this.removeEventListener(
        'loadend',
        onLoadEnd
      );

      throw err;
    }
  };

const KS1_WINDOW_MESSAGE_SOURCE =
  'makerworld-to-kobra-s1';

function sendKS1MainWorldReady() {
  window.postMessage(
    {
      source:
        KS1_WINDOW_MESSAGE_SOURCE,

      action:
        'main-world-ready',
    },
    '*'
  );
}

function sendKS1PrinterSwiperRepairResult(
  wrapperId,
  result,
  details = {}
) {
  window.postMessage(
    {
      source:
        KS1_WINDOW_MESSAGE_SOURCE,

      action:
        'printer-swiper-repair-result',

      wrapperId:
        String(wrapperId || ''),

      result:
        String(result || 'unknown'),

      details: {
        swiperFound:
          details.swiperFound === true,

        slideToAvailable:
          details.slideToAvailable === true,

        navigationUpdated:
          details.navigationUpdated === true,

        message:
          String(details.message || ''),
      },
    },
    '*'
  );
}

function sendKS1PrinterSwiperRefreshResult(
  wrapperId,
  result,
  details = {}
) {
  window.postMessage(
    {
      source:
        KS1_WINDOW_MESSAGE_SOURCE,

      action:
        'printer-swiper-refresh-result',

      wrapperId:
        String(wrapperId || ''),

      result:
        String(result || 'unknown'),

      details: {
        swiperFound:
          details.swiperFound === true,

        navigationFound:
          details.navigationFound === true,

        navigationUpdated:
          details.navigationUpdated === true,

        message:
          String(details.message || ''),
      },
    },
    '*'
  );
}

function refreshKS1PrinterSwiper(
  wrapperId
) {
  const normalizedId =
    String(wrapperId || '');

  // Only accept the short internal identifiers generated by content.js.
  // Never accept arbitrary selectors or executable values from page messages.
  if (
    !/^ks1-[a-z0-9-]{1,80}$/i.test(
      normalizedId
    )
  ) {
    return;
  }

  const wrapper =
    Array.from(
      document.querySelectorAll(
        '[data-ks1-refresh-id]'
      )
    ).find(
      candidate =>
        candidate.dataset.ks1RefreshId ===
        normalizedId
    );

  if (!wrapper) {
    sendKS1PrinterSwiperRefreshResult(
      normalizedId,
      'wrapper-not-found'
    );

    return;
  }

  const swiperElement =
    wrapper.closest('.swiper');

  const swiper =
    swiperElement?.swiper;

  if (
    !swiper ||
    typeof swiper.update !== 'function'
  ) {
    // Some MakerWorld/Swiper versions may not expose the Swiper instance
    // directly on the DOM element. Request MakerWorld's responsive layout
    // recalculation as a safe fallback.
    window.dispatchEvent(
      new Event('resize')
    );

    sendKS1PrinterSwiperRefreshResult(
      normalizedId,
      'resize-fallback-dispatched',
      {
        swiperFound:
          false,
      }
    );

    return;
  }

  let navigationFound =
    false;

  let navigationUpdated =
    false;

  function updateSwiper() {
    swiper.update();

    if (
      typeof swiper.updateSlides ===
      'function'
    ) {
      swiper.updateSlides();
    }

    if (
      typeof swiper.updateSlidesClasses ===
      'function'
    ) {
      swiper.updateSlidesClasses();
    }

    navigationFound =
      Boolean(swiper.navigation);

    if (
      typeof swiper.navigation?.update ===
      'function'
    ) {
      swiper.navigation.update();

      navigationUpdated =
        true;
    }
  }

  try {
    // Update immediately so the new KS1 slide becomes part of Swiper's
    // internal slide collection.
    updateSwiper();

    // Update once more after the browser has processed the changed layout.
    // This is especially important when the KS1 slide creates the first
    // horizontal overflow in an otherwise completely visible printer list.
    requestAnimationFrame(
      () => {
        try {
          updateSwiper();

          sendKS1PrinterSwiperRefreshResult(
            normalizedId,
            'updated',
            {
              swiperFound:
                true,

              navigationFound,
              navigationUpdated,
            }
          );
        } catch (error) {
          console.warn(
            '[KS1 injected] Delayed printer Swiper refresh failed:',
            error
          );

          sendKS1PrinterSwiperRefreshResult(
            normalizedId,
            'update-failed',
            {
              swiperFound:
                true,

              navigationFound,
              navigationUpdated,

              message:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );
        }
      }
    );
  } catch (error) {
    console.warn(
      '[KS1 injected] Printer Swiper refresh failed:',
      error
    );

    sendKS1PrinterSwiperRefreshResult(
      normalizedId,
      'update-failed',
      {
        swiperFound:
          true,

        navigationFound,
        navigationUpdated,

        message:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );
  }
}

function repairKS1PrinterSwiperVisibility(
  wrapperId
) {
  const normalizedId =
    String(wrapperId || '');

  if (
    !/^ks1-[a-z0-9-]{1,80}$/i.test(
      normalizedId
    )
  ) {
    return;
  }

  const wrapper =
    Array.from(
      document.querySelectorAll(
        '[data-ks1-repair-id]'
      )
    ).find(
      candidate =>
        candidate.dataset.ks1RepairId ===
        normalizedId
    );

  if (!wrapper) {
    sendKS1PrinterSwiperRepairResult(
      normalizedId,
      'wrapper-not-found'
    );

    return;
  }

  const swiperElement =
    wrapper.closest('.swiper');

  const swiper =
    swiperElement?.swiper;

  if (
    !swiper ||
    typeof swiper.update !== 'function'
  ) {
    window.dispatchEvent(
      new Event('resize')
    );

    sendKS1PrinterSwiperRepairResult(
      normalizedId,
      'resize-fallback-dispatched',
      {
        swiperFound:
          false,

        slideToAvailable:
          false,
      }
    );

    return;
  }

  const slideToAvailable =
    typeof swiper.slideTo ===
    'function';

  let navigationUpdated =
    false;

  function updateNavigation() {
    if (
      typeof swiper.navigation?.update ===
      'function'
    ) {
      swiper.navigation.update();

      navigationUpdated =
        true;
    }
  }

  function performRepair() {
    swiper.update();

    if (
      typeof swiper.updateSlides ===
      'function'
    ) {
      swiper.updateSlides();
    }

    if (slideToAvailable) {
      // The KS1 option is inserted directly after MakerWorld's first filter.
      // Move to the logical start only after content.js has confirmed that the
      // option exists but is outside the visible Swiper viewport.
      swiper.slideTo(
        0,
        0,
        false
      );
    }

    swiper.update();

    if (
      typeof swiper.updateSlidesClasses ===
      'function'
    ) {
      swiper.updateSlidesClasses();
    }

    updateNavigation();
  }

  try {
    performRepair();

    requestAnimationFrame(
      () => {
        try {
          performRepair();

          sendKS1PrinterSwiperRepairResult(
            normalizedId,
            slideToAvailable
              ? 'repaired-to-start'
              : 'updated-without-slide-to',
            {
              swiperFound:
                true,

              slideToAvailable,
              navigationUpdated,
            }
          );
        } catch (error) {
          console.warn(
            '[KS1 injected] Delayed printer Swiper visibility repair failed:',
            error
          );

          sendKS1PrinterSwiperRepairResult(
            normalizedId,
            'repair-failed',
            {
              swiperFound:
                true,

              slideToAvailable,
              navigationUpdated,

              message:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );
        }
      }
    );
  } catch (error) {
    console.warn(
      '[KS1 injected] Printer Swiper visibility repair failed:',
      error
    );

    sendKS1PrinterSwiperRepairResult(
      normalizedId,
      'repair-failed',
      {
        swiperFound:
          true,

        slideToAvailable,
        navigationUpdated,

        message:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );
  }
}

window.addEventListener('message', (e) => {
  if (
    e.source !== window ||
    !e.data
  ) {
    return;
  }

  if (
    e.data.source ===
      KS1_WINDOW_MESSAGE_SOURCE &&
    e.data.action ===
      'main-world-status-request'
  ) {
    sendKS1MainWorldReady();

    return;
  }

  if (
    e.data.source ===
      KS1_WINDOW_MESSAGE_SOURCE &&
    e.data.action ===
      'refresh-printer-swiper'
  ) {
    refreshKS1PrinterSwiper(
      e.data.wrapperId
    );

    return;
  }

  if (
    e.data.source ===
      KS1_WINDOW_MESSAGE_SOURCE &&
    e.data.action ===
      'repair-printer-swiper-visibility'
  ) {
    repairKS1PrinterSwiperVisibility(
      e.data.wrapperId
    );

    return;
  }

  if (
    e.data.__ks1SetMode !== undefined
  ) {
    console.log(
      '[KS1 injected] mode set to',
      e.data.__ks1SetMode
    );

    window.__ks1ModeActive =
      e.data.__ks1SetMode;
  }

  if (e.data.__ks1StartCapture) {
    console.log(
      '[KS1 injected] capture armed'
    );

    ks1CaptureGeneration +=
      1;

    window.__ks1Capturing =
      true;
  }

  if (e.data.__ks1CancelCapture) {
    ks1CaptureGeneration +=
      1;

    window.__ks1Capturing =
      false;
  }
});

// Notify content.js after the Main World message listener is fully ready.
//
// content.js also actively requests this status, so the handshake works
// regardless of which script finishes loading first.
sendKS1MainWorldReady();

// Block any native <a download> clicks while KS1 mode is active
document.addEventListener('click', (e) => {
  if (!window.__ks1ModeActive) return;
  const a = e.target.closest('a[download]');
  if (a) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
