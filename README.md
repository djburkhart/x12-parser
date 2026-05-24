# Description

A typed EDI toolkit for Node.js that can now be used as an importable foundation for a supply chain dashboard or translation layer. It keeps the original stream-based X12 parser/grouper and adds higher-level APIs for X12 and EDIFACT parsing, generation, validation, acknowledgments, and JSON-to-EDI mapping.

- 🎉 Fully typed
- 🚫 Zero production dependencies
- 🧪 100% code coverage
- 📁 Supports large multi-gigabyte files
- 🏞️ Native NodeJS streams, easily stream into DB, cloud storage, or anything that accepts a pipe.
- 🙌 Exports CJS & ESM to ease upgrades to ESM

## What this package now covers

### Implemented

- X12 stream parsing and grouping
- X12 string parsing, generation, structural validation, and 997/999 detection
- EDIFACT string parsing, generation, structural validation, and CONTRL detection
- JSON/XML-adjacent data mapping primitives via rule-based JSON-to-EDI and EDI-to-JSON helpers
- A top-level `EdiLibrary` facade for importing into another application

### Provided as extension contracts

- Communication layer adapters for AS2, SFTP, FTP/S, VAN, and API delivery
- Trading partner profiles and certificate metadata
- Monitoring/audit logger contracts
- Integration record contracts for ERP / SCM / TMS handoff

This means the package is ready to be embedded as the EDI core of a dashboard, while protocol-specific delivery and UI/dashboard monitoring can stay in the host application.

## Quick start

```ts
import {
  EdiLibrary,
  parseX12,
  parseEdifact,
  validateX12,
  mapJsonToEdiSegments,
} from 'x12-parser';

const edi = new EdiLibrary();

const x12 = edi.parse(x12Payload, 'x12');
const edifact = edi.parse(edifactPayload, 'edifact');

const validation = validateX12(x12);
const outboundSegments = mapJsonToEdiSegments(orderJson, [
  { from: 'order.number', segment: 'BEG', element: 3 },
  { from: 'order.customer.code', segment: 'N1', element: 2 },
]);
```

## Library API

### High-level facade

- `EdiLibrary`
- `x12Adapter`
- `edifactAdapter`

### X12 helpers

- `parseX12(input)`
- `parseX12Formatted(input)`
- `generateX12(document)`
- `validateX12(document)`
- `detectX12Acknowledgment(document)`

### EDIFACT helpers

- `parseEdifact(input)`
- `generateEdifact(document)`
- `validateEdifact(document)`
- `detectEdifactAcknowledgment(document)`

### Mapping helpers

- `mapJsonToEdiSegments(payload, rules, seedSegments?)`
- `mapEdiToJson(document, rules)`

### Platform contracts

- `TradingPartnerProfile`
- `EdiTransportAdapter`
- `EdiAuditLogger`
- `EdiIntegrationRecord`

## Why are streams important?

EDI files can be very large and may be transmitted with multiple transactions inside one file. With the unknown size of these files it's very easy for them to consume lots of RAM, these numbers may look small to start but make it nearly impossible or costly to process EDI files that are hundreds of megabytes or more.

The below example used a 15.5MiB file with 565,832 lines.

| Stream Type             | RAM Usage  | Objects Exiting Stream |
| ----------------------- | ---------- | ---------------------- |
| Group only segments     | 47MiB      | 565,832                |
| Group on CLP (835)      | 53MiB      | 20,166                 |
| Group on ISA (envelope) | **294MiB** | 1                      |

## Example usage

`pnpm add x12-parser`

The X12parser is a Node Transform Stream, so you must pipe a read stream to it. The simplest and most common way to do this is using `fs.createReadStream` in NodeJS, however you should be able to use other read streams as long as they are sending the data unmodified from the source file. If you need to control the encoding you can pass `defaultEncoding` to the X12parser, for example `X12parser('utf8')`.

The X12parser will then push every segment as an object, you can either `pipe()` this data to another stream or you can directly consume the `data` events from the X12parser.

Every segment will be an object with a `name` key and multiple string counter keys, incrementing based on their element number. For example if there was a `HAI` segment with only 1 element it would look like this: `{"name": "HAI", "1": "HI!"}`.

```ts
import { X12parser } from 'x12-parser';
import { createReadStream } from 'node:fs';

// Usage with async/await
async function parseEdiFile(filePath) {
  try {
    const ediFile = createReadStream(filePath);
    const parser = new X12parser();

    for await (const data of ediFile.pipe(parser)) {
      console.log(data);
    }
  } catch (err) {
    console.error('An error occurred:', err);
  }
}

// Run the parser
parseEdiFile('./test-file.edi');
```

You can also write this with event emitters without async/await like this:

```ts
import { X12parser } from 'x12-parser';
import { createReadStream } from 'node:fs';

const parser = new X12parser();
parser.on('error', (err) => {
  console.error(err);
});

// Create a read stream from a file
const ediFile = createReadStream('./test-file.edi');
ediFile.on('error', (err) => {
  console.error(err);
});

// Handle events from the parser
ediFile.pipe(parser).on('data', (data) => {
  console.log(data);
});
```

## Notes

This lib does not enforce 2-character segment & component names, it simply increments the number. For example, `ISA01` would be `ISA1` in the output object and `ISA10` would still be `ISA10`. Similarly, components such as `SVC01-01` would be `SVC1-1`.

### Grouping

The grouping stage is a transform stream, it is designed to help group unbounded loops in the X12 files. You must provide it a list of groups and what indicates the start / stop of a loop. If the loop is unbounded the stop is `null`.

Every group will be accumulated until another group starts, at which point the group will be pushed down the stream. This should be kept in mind when grouping, because making large groups could cause memory issues and reduce performance of streams. If a loop is unbounded it will be terminated by either another peer loop or it will be terminated by the closer of a parent loop.

The grouper can accept an array of schemas or a single schema. The grouper will try to select the schema version that matches `GS08`. If no schemas match `GS08` it will look for a schema with the defaultSchema key set to true, if there are none it will then select the first schema in the array of schemas.

Below is an example of grouping everything inside the ISA, however **this is not a good idea** for production. There is an unknown number of nested elements and it may have memory issues. It would be better in this case to group on something else, for example grouping the CLP segments work well in 835s.

### Grouper Example

```ts
import { X12parser, X12grouper, Schema } from 'x12-parser';
import { createReadStream } from 'node:fs';

// Every schema can be associated with a version, which will attempt to be matched to
// the GS08, if none match the default schema or first schema in array will be used.
// This can be helpful when the files being passed may span a few versions and different
// grouping is needed for each version, so long as the version is properly set in the GS08.
const mySchema = new Schema('005010X221A1', {
  start: 'ISA', // What segment starts the group
  end: 'IEA', // What segment ends the group
  name: 'Envelope', // What is the name of the group
  groups: [
    // Nested groups, each group turns into an object and each nested group an array of objects
    {
      start: 'BPR',
      terminators: ['N1'],
      name: 'headers',
    },
    {
      start: 'N1',
      terminators: ['LX'],
      name: '1000',
    },
    {
      start: 'LX',
      name: '2000',
      terminators: ['SE'],
      groups: [
        {
          start: 'CLP',
          name: '2100',
          groups: [
            {
              start: 'SVC',
              name: '2110',
            },
          ],
        },
      ],
    },
  ],
});

async function processEdiFile(filePath) {
  try {
    const parser = new X12parser();
    const grouper = new X12grouper(mySchema);
    const testFile = createReadStream(filePath);

    console.log(`Processing EDI file: ${filePath}`);

    const ediStream = testFile.pipe(parser).pipe(grouper);

    for await (const data of ediStream) {
      console.log(JSON.stringify(data, null, 2));
    }

    console.log('Successfully finished processing the file.');
  } catch (err) {
    console.error('An error occurred during processing:', err);
  }
}

processEdiFile('./test-835.edi');
```

### Using Stream Promises

Often times it makes sense to pipe the output to another stream that writes the data to a database, file, bucket, etc. When doing that you can use node:stream/promises to easily handle the asynchronous nature of the pipeline.

```ts
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { X12parser, X12grouper, Schema } from 'x12-parser';

const mySchema = new Schema('005010X221A1', {
  start: 'ISA', // What segment starts the group
  end: 'IEA', // What segment ends the group
  name: 'Envelope', // What is the name of the group
  groups: [
    // Nested groups, each group turns into an object and each nested group an array of objects
    {
      start: 'BPR',
      terminators: ['N1'],
      name: 'headers',
    },
    {
      start: 'N1',
      terminators: ['LX'],
      name: '1000',
    },
    {
      start: 'LX',
      name: '2000',
      terminators: ['SE'],
      groups: [
        {
          start: 'CLP',
          name: '2100',
          groups: [
            {
              start: 'SVC',
              name: '2110',
            },
          ],
        },
      ],
    },
  ],
});

// This new Transform stream converts JavaScript objects into formatted JSON strings to write to a simple text file.
const jsonStringifier = new Transform({
  writableObjectMode: true,
  transform(chunk, encoding, callback) {
    const jsonString = JSON.stringify(chunk, null, 2) + '\n';
    callback(null, jsonString);
  },
});

async function parseAndSaveFile(inputFile, outputFile) {
  console.log(`Processing ${inputFile} -> ${outputFile}`);
  try {
    const source = createReadStream(inputFile);
    const parser = new X12parser();
    const grouper = new X12grouper(mySchema);
    const destination = createWriteStream(outputFile);

    // Await pipeline to finish or throw an error
    await pipeline(source, parser, grouper, jsonStringifier, destination);

    console.log('File processed and saved successfully.');
  } catch (err) {
    console.error('Pipeline failed:', err);
  }
}

parseAndSaveFile('./test-file.edi', './output.json');
```
