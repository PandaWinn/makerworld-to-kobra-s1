// Background script — handles converted file downloads + Slicer Next bridge.
//
// One-click open support lives in ks1_native_bridge.js (pure protocol
// helpers). Chrome loads it via importScripts below; Firefox lists it in
// manifest.firefox.json background.scripts ahead of this file.

try {
  if (typeof importScripts === 'function') {
    importScripts('ks1_native_bridge.js');
  }
} catch (error) {
  console.warn(
    '[KobraS1 Extension] bridge helpers unavailable:',
    error
  );
}
//
// Chrome/Chromium:
// Receives a Blob URL created by the content script.
//
// Firefox:
// Receives the finished binary data and creates a new Blob URL inside
// the extension background context, because Firefox blocks access to
// MakerWorld-context Blob URLs from downloads.download().

const isFirefoxBackground =
  chrome.runtime.getURL('').startsWith('moz-extension://');

const pendingKS1DownloadResponses =
  new Map();

let ks1FilenameListenerRegistered =
  false;

function getKS1PendingDownloadStorageKey(
  url
) {
  return (
    'ks1-pending-download:' +
    String(url || '')
  );
}

function getKS1DownloadBasename(
  filename
) {
  const value =
    String(filename || '');

  return (
    value
      .split(/[\\/]/)
      .pop() ||
    value
  );
}

function removeKS1FilenameListenerIfIdle() {
  if (
    pendingKS1DownloadResponses.size > 0 ||
    !ks1FilenameListenerRegistered
  ) {
    return;
  }

  try {
    chrome.downloads
      .onDeterminingFilename
      .removeListener(
        handleKS1DeterminingFilename
      );
  } catch {
    // Nothing to clean up.
  }

  ks1FilenameListenerRegistered =
    false;
}

function cleanupKS1PendingDownload(
  storageKey
) {
  pendingKS1DownloadResponses.delete(
    storageKey
  );

  chrome.storage.session.remove(
    storageKey
  );

  removeKS1FilenameListenerIfIdle();
}

function completeKS1DownloadResponse(
  storageKey,
  downloadId,
  filenameForced
) {
  const pendingResponse =
    pendingKS1DownloadResponses.get(
      storageKey
    );

  if (!pendingResponse) {
    return;
  }

  cleanupKS1PendingDownload(
    storageKey
  );

  pendingResponse({
    ok:
      true,

    downloadId:
      downloadId ??
      null,

    filenameForced:
      filenameForced ===
      true,
  });
}

function ensureKS1FilenameListener() {
  if (
    ks1FilenameListenerRegistered ||
    isFirefoxBackground ||
    !chrome.downloads
      ?.onDeterminingFilename
  ) {
    return;
  }

  chrome.downloads
    .onDeterminingFilename
    .addListener(
      handleKS1DeterminingFilename
    );

  ks1FilenameListenerRegistered =
    true;
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Optional Chromium filename forcing.
//
// This listener is registered only while a converted KS1 download explicitly
// requests filename forcing. With the option disabled, Chromium uses the
// normal downloads.download({ filename }) path without this listener.

function handleKS1DeterminingFilename(
  downloadItem,
  suggest
) {
  // Never interfere with a download explicitly attributed to another
  // extension.
  if (
    downloadItem.byExtensionId &&
    downloadItem.byExtensionId !==
      chrome.runtime.id
  ) {
    suggest();
    return;
  }

  const candidateUrls =
    Array.from(
      new Set(
        [
          downloadItem.url,
          downloadItem.finalUrl,
        ].filter(Boolean)
      )
    );

  const storageKeys =
    candidateUrls.map(
      getKS1PendingDownloadStorageKey
    );

  if (!storageKeys.length) {
    suggest();
    return;
  }

  chrome.storage.session.get(
    storageKeys,
    stored => {
      if (
        chrome.runtime.lastError
      ) {
        console.warn(
          '[KobraS1 Extension] forced filename state read failed:',
          chrome.runtime.lastError.message
        );

        suggest();
        return;
      }

      let pendingKey =
        null;

      let pending =
        null;

      for (
        const key of
        storageKeys
      ) {
        if (
          stored?.[key]
            ?.forceFilename === true
        ) {
          pendingKey =
            key;

          pending =
            stored[key];

          break;
        }
      }

      // Not one of the currently pending forced KS1 downloads.
      if (
        !pendingKey ||
        !pending
      ) {
        suggest();
        return;
      }

      const expectedFilename =
        getKS1DownloadBasename(
          pending.expectedFilename
        );

      if (!expectedFilename) {
        console.warn(
          '[KobraS1 Extension] forced filename is empty'
        );

        suggest();

        completeKS1DownloadResponse(
          pendingKey,
          downloadItem.id,
          false
        );

        return;
      }

      suggest({
        filename:
          expectedFilename,

        conflictAction:
          'uniquify',
      });

      completeKS1DownloadResponse(
        pendingKey,
        downloadItem.id,
        true
      );
    }
  );

  // chrome.storage.session is asynchronous.
  return true;
}

function ks1BridgeSend(port, obj, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('Bridge response timeout'));
    }, timeoutMs);

    const onMsg = response => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      try {
        port.onMessage.removeListener(onMsg);
      } catch {
        // Listener already gone.
      }

      resolve(response);
    };

    port.onMessage.addListener(onMsg);

    try {
      port.postMessage(obj);
    } catch (error) {
      if (done) return;
      done = true;
      clearTimeout(timer);

      try {
        port.onMessage.removeListener(onMsg);
      } catch {
        // Listener already gone.
      }

      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function handleKS1BridgeOpen(msg, sendResponse) {
  let port = null;
  let gotReply = false;

  try {
    if (
      typeof KS1_BRIDGE_HOST === 'undefined' ||
      typeof buildKS1OpenPlan !== 'function' ||
      typeof encodeKS1Chunk !== 'function'
    ) {
      throw new Error('Bridge protocol helpers unavailable');
    }

    const data =
      msg.data instanceof ArrayBuffer
        ? new Uint8Array(msg.data)
        : null;

    if (!data || data.byteLength === 0) {
      throw new Error('Empty model data');
    }

    const plan = buildKS1OpenPlan(msg.filename, data.byteLength);

    try {
      port = chrome.runtime.connectNative(KS1_BRIDGE_HOST);
    } catch (connectError) {
      sendResponse({
        ok: false,
        hostMissing: true,
        error:
          'Native bridge not installed. Run native_host/install.sh, or switch back to Download in the extension settings.',
      });

      return;
    }

    let disconnectMessage = '';

    port.onDisconnect.addListener(() => {
      try {
        disconnectMessage =
          chrome.runtime.lastError?.message || '';
      } catch {
        disconnectMessage = '';
      }
    });

    const deadline = Date.now() + 120000;

    const send = async obj => {
      if (!port) throw new Error('Bridge disconnected');

      const left = deadline - Date.now();

      if (left <= 0) throw new Error('Bridge timed out');

      const response = await ks1BridgeSend(
        port,
        obj,
        Math.min(30000, left)
      );

      gotReply = true;

      if (!response?.ok) {
        const failure = new Error(
          response?.error || 'Bridge error'
        );

        failure.bridgeResponse = response;

        throw failure;
      }

      return response;
    };

    await send({
      protocol: KS1_BRIDGE_PROTOCOL,
      action: 'open-begin',
      transfer_id: plan.transferId,
      filename: plan.filename,
      total_bytes: plan.totalBytes,
      total_chunks: plan.totalChunks,
    });

    for (let index = 0; index < plan.totalChunks; index++) {
      await send({
        protocol: KS1_BRIDGE_PROTOCOL,
        action: 'open-chunk',
        transfer_id: plan.transferId,
        index,
        data_b64: encodeKS1Chunk(data, index),
      });
    }

    const done = await send({
      protocol: KS1_BRIDGE_PROTOCOL,
      action: 'open-commit',
      transfer_id: plan.transferId,
    });

    sendResponse({
      ok: true,
      path: done.path || null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.warn('[KobraS1 Extension] open in slicer failed:', message);

    sendResponse({
      ok: false,
      hostMissing: !gotReply,
      error: message,
    });
  } finally {
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

async function handleKS1BridgePing(sendResponse) {
  let port = null;

  try {
    if (typeof KS1_BRIDGE_HOST === 'undefined') {
      throw new Error('Bridge protocol helpers unavailable');
    }

    try {
      port = chrome.runtime.connectNative(KS1_BRIDGE_HOST);
    } catch (connectError) {
      sendResponse({
        ok: false,
        hostMissing: true,
        error: 'Native bridge not installed.',
      });

      return;
    }

    const response = await ks1BridgeSend(
      port,
      { protocol: KS1_BRIDGE_PROTOCOL, action: 'ping' },
      10000
    );

    sendResponse({
      ok: response?.ok === true,
      hostMissing: false,
      slicerFound: response?.slicer_found === true,
      version: response?.version || null,
    });
  } catch (error) {
    sendResponse({
      ok: false,
      hostMissing: true,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ks1_open_in_slicer') {
    handleKS1BridgeOpen(msg, sendResponse);
    return true;
  }

  if (msg?.type === 'ks1_bridge_ping') {
    handleKS1BridgePing(sendResponse);
    return true;
  }

  if (msg?.type === 'ks1_download') {
    const forceFilename =
      msg.forceFilename === true;

    // Normal/default path.
    //
    // Do not arm the filename listener at all when forcing is disabled.
    // Chromium receives exactly the same explicit filename as before.
    if (!forceFilename) {
      chrome.downloads.download(
        {
          url:
            msg.url,

          filename:
            msg.filename,

          conflictAction:
            'uniquify',
        },
        downloadId => {
          if (
            chrome.runtime.lastError
          ) {
            const error =
              chrome.runtime
                .lastError.message;

            console.warn(
              '[KobraS1 Extension] download failed:',
              error
            );

            sendResponse({
              ok:
                false,

              error,
            });

            return;
          }

          sendResponse({
            ok:
              true,

            downloadId:
              downloadId ??
              null,

            filenameForced:
              false,
          });
        }
      );

      return true;
    }

    // Optional forced-filename compatibility path.
    const storageKey =
      getKS1PendingDownloadStorageKey(
        msg.url
      );

    const pendingDownload = {
      url:
        String(msg.url || ''),

      expectedFilename:
        String(msg.filename || ''),

      forceFilename:
        true,

      createdAt:
        Date.now(),
    };

    pendingKS1DownloadResponses.set(
      storageKey,
      sendResponse
    );

    ensureKS1FilenameListener();

    const startForcedDownload =
      () => {
        chrome.downloads.download(
          {
            url:
              msg.url,

            filename:
              msg.filename,

            conflictAction:
              'uniquify',
          },
          downloadId => {
            if (
              chrome.runtime.lastError
            ) {
              const error =
                chrome.runtime
                  .lastError.message;

              cleanupKS1PendingDownload(
                storageKey
              );

              console.warn(
                '[KobraS1 Extension] download failed:',
                error
              );

              sendResponse({
                ok:
                  false,

                error,
              });

              return;
            }

            // Successful forced downloads are reported by
            // onDeterminingFilename after the explicit filename suggestion
            // has been applied.
          }
        );
      };

    chrome.storage.session.set(
      {
        [storageKey]:
          pendingDownload,
      },
      () => {
        if (
          chrome.runtime.lastError
        ) {
          const storageError =
            chrome.runtime
              .lastError.message;

          console.warn(
            '[KobraS1 Extension] forced filename state could not be stored:',
            storageError
          );

          // Do not risk blocking the download when the optional forcing state
          // cannot be prepared. Fall back to the normal Chromium path.
          cleanupKS1PendingDownload(
            storageKey
          );

          chrome.downloads.download(
            {
              url:
                msg.url,

              filename:
                msg.filename,

              conflictAction:
                'uniquify',
            },
            downloadId => {
              if (
                chrome.runtime.lastError
              ) {
                const error =
                  chrome.runtime
                    .lastError.message;

                sendResponse({
                  ok:
                    false,

                  error,
                });

                return;
              }

              sendResponse({
                ok:
                  true,

                downloadId:
                  downloadId ??
                  null,

                filenameForced:
                  false,
              });
            }
          );

          return;
        }

        startForcedDownload();
      }
    );

    return true;
  }

  if (msg?.type === 'ks1_download_firefox') {
    if (!isFirefoxBackground) {
      sendResponse({
        ok: false,
        error: 'Firefox download handler is unavailable',
      });
      return false;
    }

    (async () => {
      let objectUrl = null;

      try {
        if (!(msg.data instanceof ArrayBuffer)) {
          throw new TypeError(
            'Firefox download data is not an ArrayBuffer'
          );
        }

        const bytes = new Uint8Array(msg.data);

        if (bytes.byteLength === 0) {
          throw new Error('Firefox download data is empty');
        }

        const blob = new Blob(
          [bytes],
          { type: 'application/octet-stream' }
        );

        objectUrl = URL.createObjectURL(blob);

        const downloadId = await browser.downloads.download({
          url: objectUrl,
          filename: msg.filename,
          saveAs: false,
        });

        sendResponse({
          ok: true,
          downloadId,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.warn(
          '[KobraS1 Extension] Firefox download failed:',
          message
        );

        sendResponse({
          ok: false,
          error: message,
        });
      } finally {
        if (objectUrl) {
          // Keep the URL alive long enough for Firefox's download manager
          // to open it before releasing the temporary Blob resource.
          setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
          }, 60_000);
        }
      }
    })();

    return true;
  }

  return false;
});