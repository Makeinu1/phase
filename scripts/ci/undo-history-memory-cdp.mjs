// Read numeric lengths through CDP's existing heap API. Never read memory bytes.
export async function wasmMemoryRegions(call, sessionId) {
  const ids = [];
  try {
    const prototype = await call('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype', returnByValue: false }, sessionId);
    if (!prototype.result.objectId || prototype.exceptionDetails) throw Error('WASM memory prototype unavailable');
    ids.push(prototype.result.objectId);
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId }, sessionId);
    ids.push(objects.objects.objectId);
    const lengths = await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
      functionDeclaration: 'function(){ return Array.from(this, memory => memory.buffer.byteLength); }', returnByValue: true }, sessionId);
    if (lengths.exceptionDetails || !Array.isArray(lengths.result.value)
      || !lengths.result.value.every(n => Number.isSafeInteger(n) && n >= 0 && n % 65536 === 0)) throw Error('Invalid numeric WASM region observation');
    return { memoryObjects: lengths.result.value.length, regionBytes: lengths.result.value,
      totalAllocatedRegionBytes: lengths.result.value.reduce((sum, n) => sum + n, 0),
      scope: 'live JS-reachable WebAssembly.Memory objects in this Worker, allocated buffer lengths; not used bytes or an engine-free guarantee' };
  } finally {
    for (const objectId of ids.reverse()) await call('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}
