# Private preview RTC QA route

This is an opt-in transport for owner-authenticated, same-origin two-tab QA.
It uses a random URL-fragment namespace for BroadcastChannel SDP/ICE routing,
   then sends game bytes only over an ordered RTCDataChannel. The factory always
constructs `RTCPeerConnection` with `iceServers: []`; an explicit QA opt-in
fails closed if the browser APIs or installer are unavailable. With no
`#phase-qa-rtc=` fragment, the normal PeerJS selector and production behavior
remain unchanged.

This guarantee applies to the host/join gameplay route. Do not launch the
separate connectivity diagnostics during this QA pass: that existing action
fetches TURN configuration independently. Legacy P2P trace messages and the
normal PeerJS "registered on signaling server" messages are not transport
proof; the QA factory suppresses those registration messages, and the bounded
RTC snapshot below is the state evidence.

## Prepare the private preview

Build and review the client from the intended commit, then stage its changed
client assets through the existing owner-only private Site workflow. Keep the
current Site, its owner-only access, and its existing asset location. Direct-code
hosting should set `brokerUrl: null`; this QA route does not use PeerJS
signaling, a new backend/account, STUN/TURN, or a tunnel. Do not publish test
fixture data. No Site deployment was performed for this change.

The known preview snapshot is owner-only at
`https://phase-private-qa-preview.kiue20002001.chatgpt.site/`, identified as
11f43/WASM b381, and is missing art, audio, and Draft assets. Verify the Site's
current assets and served commit before testing; that snapshot is not evidence
of the current main runtime or browser API availability.

## Prove the transport before opening a game

1. Open two tabs on the same authenticated private Site origin. Create a
   one-time namespace in the console with
   `crypto.randomUUID().replaceAll("-", "")`, then open both tabs with the
   same `#phase-qa-rtc=<namespace>` fragment. The fragment is not sent in the
   HTTP request. Start with a fresh room and new page loads each run. Tab peer
   identities are per-page cryptographic UUIDs; both tabs still share the same
   browser profile and storage.
2. In tab A, create a host probe peer and echo binary data on an incoming
   connection:

   ```js
   const qaRoom = `qa-${crypto.randomUUID().replaceAll("-", "")}`;
   const qaHost = window.__PHASE_QA_PRIVATE_RTC__.createProbePeer(qaRoom);
   qaHost.on("connection", (conn) => conn.on("data", (bytes) => conn.send(bytes)));
   qaHost.once("open", () => console.info("private RTC host peer open"));
   ```

   Share `qaRoom` with tab B. In tab B, connect and check an exact binary echo:

   ```js
   const qaGuest = window.__PHASE_QA_PRIVATE_RTC__.createProbePeer();
   qaGuest.once("open", () => {
     const conn = qaGuest.connect(qaRoom, { serialization: "binary", reliable: true });
     const expected = new Uint8Array([0, 1, 2, 255]);
     conn.once("data", (actual) => {
       console.info("private RTC binary echo matches",
         actual instanceof Uint8Array && actual.byteLength === expected.byteLength
           && expected.every((byte, i) => actual[i] === byte));
     });
     conn.once("open", () => conn.send(expected));
   });
   ```

   Do not print the received payload. In either tab, close its probe with
   `qaHost.destroy()` or `qaGuest.destroy()` before using the game UI.
3. In both tabs inspect
   `window.__PHASE_QA_PRIVATE_RTC__.snapshot()`. Proceed only when the selected
   connection reports ICE `connected` or `completed`, the data channel is
   `open` and `ordered`, and sent/received frame and byte counters show the
   binary round trip. The snapshot reports bounded states and counters only;
   it does not expose SDP, ICE passwords, player tokens, candidate IPs, or game
   payloads. The factory reports the negotiated SCTP `maxMessageSize` and caps
   each game frame at `min(maxMessageSize, 16,300 bytes)`. Larger or
   non-binary frames fail explicitly; there is no fragmentation or truncation.
4. Close both probe connections/peers. Then use the existing game UI in tab A
   as host/seat 0 and tab B as guest/seat 1. Keep the authorized two-seat
   fixture at 20 life each with an empty stack, A's own Swamp and Thoughtseize,
   B's empty hand, and no replacement or trigger modifiers. Use no AI, timers,
   auto-pass, reload/resume, or reconnect. Confirm the real channel remains
   open before attributing any gameplay result to this transport.

The two tabs share one browser profile, localStorage, and IndexedDB. This test
does not prove profile isolation, persistence isolation, reconnect, NAT
traversal, or Internet peer reachability. Browser API support and real
ICE/DataChannel behavior must be demonstrated in the private preview; a
restricted test environment returning `undefined` is not evidence that a
browser API is absent.

## Rollback

Remove the `#phase-qa-rtc=` fragment and reload to select the unchanged default
transport. To remove the opt-in integration from the Site, restore the prior
client assets through the existing private Site workflow. The source installer
does not alter the default selector unless the fragment is present.
