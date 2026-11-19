import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { mountDocumentHttp } from '../../apps/web/src/document-http.js';
import type {
  DocumentGateway,
  DocumentMetadata,
} from '../../packages/runtime/src/document-gateway.js';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '../../packages/runtime/src/request-runtime-view.js';

test(
  'the file transport caps reads and uploads independently before handing off bytes',
  { timeout: 10_000 },
  async () => {
    const entry = {
      run(_request: unknown, handler: (view: unknown) => Promise<void>) {
        return handler({});
      },
    } as AuthenticatedRequestRuntimeEntryAdapter;
    const metadata: DocumentMetadata = {
      linkId: 'link',
      versionId: 'version',
      fieldId: null,
      categoryId: null,
      fileName: 'file.png',
      contentType: 'image/png',
      byteLength: 1,
    };
    const gate = Promise.withResolvers<void>();
    const twoReads = Promise.withResolvers<void>();
    const twoWrites = Promise.withResolvers<void>();
    let reads = 0;
    let writes = 0;
    const gateway: DocumentGateway = {
      scannerLabel: 'test',
      async list() {
        return [];
      },
      async upload() {
        if (++writes === 2) twoWrites.resolve();
        await gate.promise;
        return metadata;
      },
      async read(_view, _target, _link, _version, deliver) {
        if (++reads === 2) twoReads.resolve();
        await gate.promise;
        deliver(metadata, Buffer.of(1));
      },
    };
    const handle = mountDocumentHttp(entry, gateway);
    const server = createServer((request, response) => {
      void handle(
        request,
        response,
        new URL(request.url!, 'http://localhost'),
        true,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = () => fetch(origin + '/?mode=preview');
    const upload = () => fetch(origin + '/?mode=upload', { method: 'POST' });
    const requests = [read(), read(), upload(), upload()];
    try {
      await Promise.all([twoReads.promise, twoWrites.promise]);
      assert.equal((await read()).status, 429);
      assert.equal((await upload()).status, 429);
      assert.deepEqual({ reads, writes }, { reads: 2, writes: 2 });
    } finally {
      gate.resolve();
      const responses = await Promise.all(requests);
      assert.deepEqual(
        responses.map(({ status }) => status),
        [200, 200, 201, 201],
      );
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
