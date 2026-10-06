# SyncCode Project Rules

## Project Goal

Build SyncCode, a real-time collaborative coding workspace
for small groups of up to 5 users.

SyncCode is NOT a Git replacement.

Git handles:
- commits
- branches
- version history
- repositories
- merging

SyncCode handles:
- live collaborative editing
- live cursors
- participant presence
- colored edit attribution
- chat
- optional voice communication
- room sessions
- real-time synchronization

## Architecture

Frontend:
- React
- TypeScript
- Monaco Editor
- Socket.IO Client
- WebRTC

Backend:
- Node.js
- Express
- Socket.IO

Database:
- PostgreSQL

Optional:
- Redis
- Redis Socket.IO adapter

## Core Constraints

Maximum participants per room: 5.

The server must be authoritative for collaborative
document revisions.

Do NOT broadcast the entire document after every keystroke.

Use operation/delta based synchronization.

Every edit operation should contain:
- operationId
- userId
- baseRevision
- position/range
- insertedText
- deletedText/deleteCount
- timestamp

The server assigns monotonically increasing revisions.

## Collaboration

Each participant receives:
- unique participant ID
- display name
- unique room color
- cursor position
- selection
- connection state
- microphone state

Use Monaco decorations for:
- remote cursors
- selections
- recent edit highlights

Do not permanently color source code.

## Room

Rooms must:
- have unique IDs
- support maximum 5 participants
- have a host
- support joining/leaving
- support optional password
- support reconnection
- preserve active document state

## Communication

Chat must be implemented using Socket.IO.

Voice must use:
- WebRTC for media
- Socket.IO only for signaling

## Code Execution

NEVER execute arbitrary user code directly
inside the Node.js server.

Use an isolated execution service/sandbox.

Apply:
- timeout
- CPU limit
- memory limit
- output limit
- process limit
- restricted filesystem
- network disabled by default

## Development Rules

Build incrementally.

Do not implement all features in one step.

After each major feature:
1. run tests
2. run the application
3. verify the feature
4. fix errors
5. update documentation

Do not introduce unnecessary dependencies.

Do not replace the architecture without explaining why.

Prioritize correctness of real-time synchronization over visual features.

Do not claim a feature is implemented unless it has been tested.
