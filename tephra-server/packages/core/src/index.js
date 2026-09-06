export class SystemClock {
    now() {
        return Date.now();
    }
}
/** Browser-safe UUIDv7 generator. The timestamp prefix makes IDs sortable by creation time. */
export class UuidV7Generator {
    clock;
    constructor(clock = new SystemClock()) {
        this.clock = clock;
    }
    generate() {
        const timestamp = this.clock.now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
            throw new RangeError('Clock returned a timestamp outside the UUIDv7 48-bit range.');
        }
        const bytes = new Uint8Array(16);
        let remaining = timestamp;
        for (let index = 5; index >= 0; index -= 1) {
            bytes[index] = remaining % 256;
            remaining = Math.floor(remaining / 256);
        }
        const random = globalThis.crypto.getRandomValues(new Uint8Array(10));
        bytes[6] = 0x70 | (random[0] & 0x0f);
        bytes[7] = random[1];
        bytes[8] = 0x80 | (random[2] & 0x3f);
        bytes.set(random.subarray(3), 9);
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}
