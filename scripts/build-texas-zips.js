#!/usr/bin/env node
'use strict';

var fs = require('fs');
var cp = require('child_process');
var input = process.argv[2];
var output = process.argv[3];
if (!input || !output) {
  console.error('Usage: node build-texas-zips.js <GeoNames US.zip> <output.js>');
  process.exit(1);
}

var rows = cp.execFileSync('unzip', ['-p', input, 'US.txt'], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024
}).trim().split('\n');
var zips = {};
rows.forEach(function (line) {
  var fields = line.split('\t');
  if (fields[4] !== 'TX' || !/^\d{5}$/.test(fields[1]) || zips[fields[1]]) return;
  var lat = parseFloat(fields[9]);
  var lng = parseFloat(fields[10]);
  if (!isFinite(lat) || !isFinite(lng)) return;
  zips[fields[1]] = [lat, lng, fields[2]];
});

var ordered = {};
Object.keys(zips).sort().forEach(function (zip) { ordered[zip] = zips[zip]; });
var source = [
  '/* Texas postal-code centroids derived from GeoNames US postal data (CC BY 4.0).',
  ' * Source: https://download.geonames.org/export/zip/',
  ' */',
  '(function () {',
  "  'use strict';",
  '  window.TexasZipCentroids = ' + JSON.stringify(ordered) + ';',
  '})();',
  ''
].join('\n');
fs.writeFileSync(output, source);
console.log('Wrote ' + Object.keys(ordered).length + ' Texas ZIP centroids to ' + output);
