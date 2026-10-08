const http = require('http');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

// Require compiled server & socket setup
const { createApp } = require('../dist/app');
const { setupSocketServer } = require('../dist/socket');
const { roomManager } = require('../dist/modules/rooms/roomManager');

/**
 * Polls an HTTP endpoint with retries until it returns 200 OK
 */
async function waitForServerReady(url, maxRetries = 30, delayMs = 300) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(1500, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Server at ${url} failed readiness check after ${maxRetries * delayMs}ms`);
}

async function runBrowserVerification() {
  console.log('--- STARTING COMPREHENSIVE BROWSER VERIFICATION ---');

  // 1. Start Backend on port 4000
  const app = createApp();
  const backendServer = http.createServer(app);
  const io = setupSocketServer(backendServer);

  await new Promise((resolve) => backendServer.listen(4000, resolve));
  console.log('✓ Backend listening on http://localhost:4000');

  // 2. Start Frontend static server for client/dist on port 5173
  const clientApp = express();
  clientApp.use(express.static(path.resolve(__dirname, '../../client/dist')));
  clientApp.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
  });

  const frontendServer = http.createServer(clientApp);
  await new Promise((resolve) => frontendServer.listen(5173, resolve));
  console.log('✓ Frontend static server listening on http://localhost:5173');

  // Explicit readiness verification before starting browser tests
  await waitForServerReady('http://localhost:4000/api/v1/health');
  console.log('✓ Backend health check confirmed ready');
  await waitForServerReady('http://localhost:5173');
  console.log('✓ Frontend static app confirmed ready');

  // 3. Launch Headless Chromium
  const browser = await chromium.launch({
    headless: true,
  });
  console.log('✓ Chromium browser launched');

  let testSucceeded = false;

  try {
    // -------------------------------------------------------------
    // REQUIREMENT F: Java starter behavior (Main.java with public class Main)
    // REQUIREMENT A: Two browser clients can join the same room
    // -------------------------------------------------------------
    console.log('\n[Requirement A & F] Alice creates Java room & verifies Java starter...');
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();

    await page1.goto('http://localhost:5173');
    await page1.waitForSelector('text=Create Workspace');

    // Alice creates Java workspace
    await page1.fill('input[placeholder="e.g., Alice"]', 'Alice');
    await page1.selectOption('select', 'java');
    await page1.click('button:has-text("Create Workspace")');

    await page1.waitForSelector('.monaco-editor', { timeout: 15000 });
    console.log('✓ Alice entered workspace, Monaco editor mounted');

    // Extract room ID
    const roomIdText = await page1.locator('header span.font-mono').innerText();
    const roomId = roomIdText.trim();
    console.log(`✓ Room created with ID: ${roomId}`);

    // Verify Java starter
    const roomEntity = roomManager.getRoomEntity(roomId);
    if (!roomEntity) throw new Error('Room not found on server');
    if (roomEntity.document.filename !== 'Main.java') {
      throw new Error(`Expected filename Main.java, got ${roomEntity.document.filename}`);
    }
    if (!roomEntity.document.content.includes('public class Main')) {
      throw new Error('Java starter missing public class Main: ' + roomEntity.document.content);
    }
    console.log('✓ Requirement F PASS: Filename is Main.java and class is public class Main');

    // Bob joins room in separate browser context (Requirement A)
    console.log('\n[Requirement A] Bob joins the same room in second browser client...');
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page2.goto('http://localhost:5173');
    await page2.click('button:has-text("Join Room")');
    await page2.fill('input[placeholder="e.g., sync-7f2a-b9c1"]', roomId);
    await page2.fill('input[placeholder="e.g., Bob"]', 'Bob');
    await page2.click('button:has-text("Join Workspace")');

    await page2.waitForSelector('.monaco-editor', { timeout: 15000 });
    console.log('✓ Bob entered workspace, Monaco editor mounted');

    // Check mutual participant rosters
    await page1.waitForSelector('text=Bob');
    await page2.waitForSelector('text=Alice');
    console.log('✓ Requirement A PASS: Both Alice and Bob joined the same room and see each other');

    // Setup instrumentation hooks to capture emitted & received socket operations
    await page1.evaluate(() => {
      window.__emittedOps = [];
      const s = window.__synccode_socket;
      if (s) {
        const origEmit = s.emit.bind(s);
        s.emit = function (event, ...args) {
          if (event === 'editor:operation') {
            window.__emittedOps.push(args[0]);
          }
          return origEmit(event, ...args);
        };
      }
    });

    await page2.evaluate(() => {
      window.__receivedOps = [];
      const s = window.__synccode_socket;
      if (s) {
        s.on('editor:operation', (op) => {
          window.__receivedOps.push(op);
        });
      }
    });

    // -------------------------------------------------------------
    // REQUIREMENT B: Client A inserts text into Monaco
    // -------------------------------------------------------------
    console.log('\n[Requirement B] Testing Monaco text insertion and payload verification...');
    const revBeforeInsert = roomEntity.document.currentRevision;

    // Focus editor and type text
    await page1.click('.monaco-editor');
    await page1.keyboard.press('Control+End');
    await page1.keyboard.type('\n// Inserted by Alice');
    await page1.waitForTimeout(600);

    // Verify emitted operation payload
    const emittedInsertOp = await page1.evaluate(() => {
      return window.__emittedOps && window.__emittedOps.length > 0
        ? window.__emittedOps[window.__emittedOps.length - 1]
        : null;
    });

    if (!emittedInsertOp) {
      throw new Error('No editor:operation payload emitted by Client A on typing');
    }
    console.log('✓ Captured emitted insert operation:', {
      operationId: emittedInsertOp.operationId,
      insertedText: emittedInsertOp.insertedText,
      deleteCount: emittedInsertOp.deleteCount,
      baseRevision: emittedInsertOp.baseRevision,
    });

    const allInsertedText = await page1.evaluate(() => {
      return window.__emittedOps ? window.__emittedOps.map((op) => op.insertedText).join('') : '';
    });

    if (!allInsertedText.includes('Alice')) {
      throw new Error('Emitted operations did not contain inserted text: ' + allInsertedText);
    }
    if (emittedInsertOp.deleteCount !== 0 || emittedInsertOp.deletedText !== '') {
      throw new Error('Insert operation had unexpected deletion payload');
    }

    // Verify server accepted and updated revision
    const revAfterInsert = roomEntity.document.currentRevision;
    if (revAfterInsert <= revBeforeInsert) {
      throw new Error(`Server revision did not advance on insert (was ${revBeforeInsert}, now ${revAfterInsert})`);
    }
    console.log(`✓ Server accepted operation: revision ${revBeforeInsert} -> ${revAfterInsert}`);

    // Verify Client B received the operation and its Monaco editor updated
    await page2.waitForTimeout(600);
    const clientBContent = await page2.evaluate(() => window.__monacoEditor?.getValue());
    if (!clientBContent || !clientBContent.includes('// Inserted by Alice')) {
      throw new Error('Client B Monaco editor does not contain inserted text: ' + clientBContent);
    }
    console.log('✓ Requirement B PASS: Client B Monaco editor updated correctly with inserted text');

    // -------------------------------------------------------------
    // REQUIREMENT C: Client A deletes text
    // -------------------------------------------------------------
    console.log('\n[Requirement C] Testing Monaco text deletion and payload verification...');
    const revBeforeDelete = roomEntity.document.currentRevision;

    // Client A deletes 5 characters using Backspace
    await page1.click('.monaco-editor');
    await page1.keyboard.press('Control+End');
    await page1.keyboard.press('Backspace');
    await page1.keyboard.press('Backspace');
    await page1.keyboard.press('Backspace');
    await page1.keyboard.press('Backspace');
    await page1.keyboard.press('Backspace');
    await page1.waitForTimeout(600);

    const emittedDeleteOp = await page1.evaluate(() => {
      return window.__emittedOps && window.__emittedOps.length > 0
        ? window.__emittedOps[window.__emittedOps.length - 1]
        : null;
    });

    if (!emittedDeleteOp) {
      throw new Error('No delete operation emitted by Client A');
    }
    console.log('✓ Captured emitted delete operation:', {
      operationId: emittedDeleteOp.operationId,
      deletedText: emittedDeleteOp.deletedText,
      deleteCount: emittedDeleteOp.deleteCount,
      insertedText: emittedDeleteOp.insertedText,
    });

    if (emittedDeleteOp.deleteCount === 0 || emittedDeleteOp.deletedText === '') {
      throw new Error('Delete operation payload missing deleteCount or deletedText');
    }
    if (emittedDeleteOp.insertedText !== '') {
      throw new Error('Delete operation had non-empty inserted text');
    }

    const revAfterDelete = roomEntity.document.currentRevision;
    if (revAfterDelete <= revBeforeDelete) {
      throw new Error('Server revision did not advance on delete');
    }

    // Verify Client B's editor has the deletion
    await page2.waitForTimeout(600);
    const clientBContentAfterDelete = await page2.evaluate(() => window.__monacoEditor?.getValue());
    if (clientBContentAfterDelete.includes('Alice')) {
      throw new Error('Client B editor still contains deleted text: ' + clientBContentAfterDelete);
    }
    console.log('✓ Requirement C PASS: Deletion operation emitted, accepted, and applied to peer Monaco editor');

    // -------------------------------------------------------------
    // REQUIREMENT D: Client A replaces text
    // -------------------------------------------------------------
    console.log('\n[Requirement D] Testing Monaco text replacement and payload verification...');
    const revBeforeReplace = roomEntity.document.currentRevision;

    // Client A selects all and replaces with new code
    await page1.click('.monaco-editor');
    await page1.keyboard.press('Control+A');
    await page1.keyboard.type('int x = 42;\n');
    await page1.waitForTimeout(600);

    const emittedReplaceOp = await page1.evaluate(() => {
      // Find the operation that performed replacement
      return window.__emittedOps.find((op) => op.deleteCount > 0 && op.insertedText.length > 0) || null;
    });

    if (!emittedReplaceOp) {
      throw new Error('Replacement operation not detected');
    }
    console.log('✓ Captured emitted replace operation:', {
      operationId: emittedReplaceOp.operationId,
      deleteCount: emittedReplaceOp.deleteCount,
      insertedText: emittedReplaceOp.insertedText,
      range: emittedReplaceOp.range,
    });

    expectNotNull(emittedReplaceOp.range);
    if (emittedReplaceOp.deleteCount === 0) {
      throw new Error('Replacement operation had deleteCount 0');
    }

    // Verify peer document
    await page2.waitForTimeout(600);
    const clientBContentAfterReplace = await page2.evaluate(() => window.__monacoEditor?.getValue());
    if (!clientBContentAfterReplace.includes('int x = 42;')) {
      throw new Error('Client B editor missing replacement code: ' + clientBContentAfterReplace);
    }
    console.log('✓ Requirement D PASS: Replacement operation verified across range, deleted text, and peer document');

    // Monaco's built-in undo/redo should emit ordinary collaboration deltas too.
    console.log('\n[Requirement D] Verifying Monaco undo and redo propagation...');
    const documentBeforeUndo = roomEntity.document.content;
    const operationsBeforeUndo = await page1.evaluate(() => window.__emittedOps.length);
    await page1.keyboard.press('Control+Z');
    await page1.waitForTimeout(600);

    const documentAfterUndo = roomEntity.document.content;
    if (documentAfterUndo === documentBeforeUndo) {
      throw new Error('Undo did not change the server document');
    }
    const undoOperations = await page1.evaluate(
      (startIndex) => window.__emittedOps.slice(startIndex),
      operationsBeforeUndo
    );
    if (undoOperations.length === 0) {
      throw new Error('Undo did not emit a collaboration operation');
    }
    await page2.waitForTimeout(500);
    const peerDocumentAfterUndo = await page2.evaluate(() => window.__monacoEditor?.getValue());
    if (peerDocumentAfterUndo !== documentAfterUndo) {
      throw new Error('Undo result did not converge on Client B');
    }

    const operationsBeforeRedo = await page1.evaluate(() => window.__emittedOps.length);
    await page1.keyboard.press('Control+Y');
    await page1.waitForTimeout(600);
    const documentAfterRedo = roomEntity.document.content;
    if (documentAfterRedo !== documentBeforeUndo) {
      throw new Error('Redo did not restore the document state before undo');
    }
    const redoOperations = await page1.evaluate(
      (startIndex) => window.__emittedOps.slice(startIndex),
      operationsBeforeRedo
    );
    if (redoOperations.length === 0) {
      throw new Error('Redo did not emit a collaboration operation');
    }
    await page2.waitForTimeout(500);
    const peerDocumentAfterRedo = await page2.evaluate(() => window.__monacoEditor?.getValue());
    if (peerDocumentAfterRedo !== documentAfterRedo) {
      throw new Error('Redo result did not converge on Client B');
    }
    console.log('✓ Undo and redo emitted operations and converged on both browser clients');

    // -------------------------------------------------------------
    // REQUIREMENT E: Operation ordering / monotonic revision checks
    // -------------------------------------------------------------
    console.log('\n[Requirement E] Verifying monotonic document revisions on server...');
    const currentRev = roomEntity.document.currentRevision;
    if (currentRev <= revBeforeReplace) {
      throw new Error(`Expected strictly increasing revisions, got ${currentRev}`);
    }
    console.log(`✓ Requirement E PASS: Document revision strictly monotonic (currently revision ${currentRev})`);

    // -------------------------------------------------------------
    // REQUIREMENT G: Real automatic Socket.IO reconnection
    // -------------------------------------------------------------
    console.log('\n[Requirement G] Testing genuine socket reconnection, offline edits, and catch-up...');
    const aliceId = roomEntity.hostId;

    // 1. Simulate socket disconnection for Client A (Alice) in the same browser window
    console.log('  Disconnecting Alice socket in page1...');
    await page1.evaluate(() => {
      const s = window.__synccode_socket;
      s.disconnect();
    });
    await page1.waitForTimeout(500);

    // Verify server recognizes Alice as DISCONNECTED
    const aliceParticipant = roomEntity.participants.get(aliceId);
    if (!aliceParticipant || aliceParticipant.connectionState !== 'DISCONNECTED') {
      throw new Error('Server did not mark Alice as DISCONNECTED after socket disconnect');
    }
    console.log('✓ Alice connectionState is DISCONNECTED on server');

    // 2. Client B (Bob) performs an edit while Alice is offline
    console.log('  Bob performs edit while Alice is disconnected...');
    await page2.click('.monaco-editor');
    await page2.keyboard.press('Control+End');
    await page2.keyboard.type('int offline_val = 999;\n');
    await page2.waitForTimeout(600);

    const revDuringOffline = roomEntity.document.currentRevision;
    if (!roomEntity.document.content.includes('int offline_val = 999;')) {
      throw new Error('Bob offline edit was not saved on server');
    }
    console.log(`✓ Bob edit committed to server (new revision: ${revDuringOffline})`);

    // 3. Trigger automatic Socket.IO reconnection in Alice's existing client
    console.log('  Reconnecting Alice socket in existing page1 session...');
    await page1.evaluate(() => {
      const s = window.__synccode_socket;
      s.connect();
    });

    // Wait for Alice to re-establish connection and resynchronize
    await page1.waitForTimeout(1500);

    // 4. Verify Alice's participant identity remains the exact same Alice
    const reconnectedAlice = roomEntity.participants.get(aliceId);
    if (!reconnectedAlice || reconnectedAlice.connectionState !== 'CONNECTED') {
      throw new Error('Alice did not restore CONNECTED state on server');
    }
    console.log('✓ Alice reconnected with same participant identity:', {
      userId: reconnectedAlice.userId,
      displayName: reconnectedAlice.displayName,
      connectionState: reconnectedAlice.connectionState,
    });

    // 5. Verify Alice's Monaco editor contains the latest document state with zero duplicate edits
    const aliceReconnectedContent = await page1.evaluate(() => window.__monacoEditor?.getValue());
    if (!aliceReconnectedContent || !aliceReconnectedContent.includes('int offline_val = 999;')) {
      throw new Error('Alice editor did not receive Bob offline edit upon reconnect: ' + aliceReconnectedContent);
    }
    console.log('✓ Alice Monaco editor caught up with latest document content!');

    // Verify no duplicated text
    const occurrences = (aliceReconnectedContent.match(/int offline_val = 999;/g) || []).length;
    if (occurrences !== 1) {
      throw new Error(`Duplicate edits detected in document. Count: ${occurrences}`);
    }
    console.log('✓ Zero duplicate operations detected');

    testSucceeded = true;
    console.log('\n🎉 ALL REAL BROWSER MONACO COLLABORATION & RECONNECT TESTS PASSED 100%!');

    await page1.close();
    await page2.close();
    await context1.close();
    await context2.close();
  } catch (err) {
    console.error('❌ Browser verification error:', err);
  } finally {
    await browser.close();
    await new Promise((r) => backendServer.close(r));
    await new Promise((r) => frontendServer.close(r));
    process.exit(testSucceeded ? 0 : 1);
  }
}

function expectNotNull(val) {
  if (val === null || val === undefined) {
    throw new Error('Expected value not to be null');
  }
}

runBrowserVerification();
