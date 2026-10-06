// Read numeric lengths through CDP's existing heap API. Never read memory bytes.
export async function wasmMemoryRegions(call, sessionId) {
  const ids = new Set();
  const remember = id => { if (typeof id === 'string' && id) ids.add(id); };
  const rememberResponse = response => {
    remember(response?.result?.objectId);
    remember(response?.objects?.objectId);
    remember(response?.exceptionDetails?.exception?.objectId);
  };
  try {
    const prototype = await call('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype', returnByValue: false }, sessionId);
    rememberResponse(prototype);
    if (!prototype.result?.objectId || prototype.exceptionDetails) throw Error('WASM memory prototype unavailable');
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId }, sessionId);
    rememberResponse(objects);
    if (!objects.objects?.objectId || objects.exceptionDetails) throw Error('WASM memory enumeration unavailable');
    const lengths = await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
      functionDeclaration: 'function(){ return Array.from(this, memory => memory.buffer.byteLength); }', returnByValue: true }, sessionId);
    rememberResponse(lengths);
    if (lengths.exceptionDetails || !Array.isArray(lengths.result?.value)
      || !lengths.result.value.every(n => Number.isSafeInteger(n) && n >= 0 && n % 65536 === 0)) throw Error('Invalid numeric WASM region observation');
    return { memoryObjects: lengths.result.value.length, regionBytes: lengths.result.value,
      sumReportedBufferBytes: lengths.result.value.reduce((sum, n) => sum + n, 0),
      scope: 'buffer lengths of Memory objects enumerated by CDP for this prototype; not complete reachability, unique physical backing, used bytes or an engine-free guarantee' };
  } finally {
    for (const objectId of [...ids].reverse()) await call('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}
