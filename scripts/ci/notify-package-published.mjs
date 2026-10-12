#!/usr/bin/env node
import { notifyPackagePublication } from './package-publication.mjs';

await notifyPackagePublication({
  channel: process.env.PUBLICATION_CHANNEL,
  sourceSha: process.env.SOURCE_SHA,
  packageVersion: process.env.PACKAGE_VERSION,
  upstreamPr: process.env.UPSTREAM_PR,
});
console.log('Notified LoomLarge of the published Embody package.');
