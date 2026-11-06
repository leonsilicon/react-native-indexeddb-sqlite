// The workload this package was written for: matrix-js-sdk's Rust crypto store
// (@matrix-org/matrix-sdk-crypto-wasm, which reaches IndexedDB through wasm-bindgen), kept
// across a restart, both unencrypted and encrypted with a passphrase.

import assert from "node:assert/strict";
import { test } from "node:test";

import * as Crypto from "@matrix-org/matrix-sdk-crypto-wasm";

import { start, tempDatabaseFile } from "./helpers.ts";

await Crypto.initAsync();

for (const passphrase of [undefined, "correct horse battery staple"]) {
  test(`the crypto store survives a restart (${passphrase ? "encrypted" : "unencrypted"})`, async () => {
    const file = tempDatabaseFile();
    const user = new Crypto.UserId("@alice:example.org");
    const device = new Crypto.DeviceId("DEVICE");
    const rooms = Array.from({ length: 5 }, (_, i) => new Crypto.RoomId(`!room${i}:example.org`));
    const machineOn = async () =>
      Crypto.OlmMachine.initFromStore(
        user,
        device,
        await Crypto.StoreHandle.open("crypto", passphrase),
      );

    // The crypto glue looks up the global indexedDB, so each instance installs itself globally.
    await start(file, { target: globalThis });
    let machine = await machineOn();
    const identity = machine.identityKeys.ed25519.toBase64();
    for (const room of rooms)
      await machine.shareRoomKey(room, [user.clone()], new Crypto.EncryptionSettings());
    const events = await Promise.all(
      rooms.flatMap((room, r) =>
        Array.from({ length: 4 }, async (_, i) => ({
          r,
          i,
          content: JSON.parse(
            await machine.encryptRoomEvent(
              room,
              "m.room.message",
              JSON.stringify({ msgtype: "m.text", body: `${r}/${i}` }),
            ),
          ),
        })),
      ),
    );
    machine.close();

    await start(file, { target: globalThis });
    machine = await machineOn();
    assert.equal(machine.identityKeys.ed25519.toBase64(), identity);
    const settings = new Crypto.DecryptionSettings(Crypto.TrustRequirement.Untrusted);
    const bodies = await Promise.all(
      events.map(async ({ r, i, content }) => {
        const event = {
          type: "m.room.encrypted",
          event_id: `$${r}_${i}`,
          origin_server_ts: 1,
          sender: user.toString(),
          content,
        };
        const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), rooms[r], settings);
        return (JSON.parse(decrypted.event) as { content: { body: string } }).content.body;
      }),
    );
    assert.deepEqual(
      bodies,
      events.map(({ r, i }) => `${r}/${i}`),
    );
    machine.close();
  });
}
