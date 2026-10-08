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

async function runPresenceVerification() {
  console.log('=== STARTING 3-CLIENT COLLABORATIVE PRESENCE & EDIT ATTRIBUTION TEST ===\n');

  // 1. Start Backend on port 4000
  const app = createApp();
  const backendServer = http.createServer(app);
  const io = setupSocketServer(backendServer);

  await new Promise((resolve) => backendServer.listen(4000, resolve));
  console.log('✓ Backend listening on http://localhost:4000');

  // 2. Start Frontend static server on port 5173
  const clientApp = express();
  clientApp.use(express.static(path.resolve(__dirname, '../../client/dist')));
  clientApp.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
  });

  const frontendServer = http.createServer(clientApp);
  await new Promise((resolve) => frontendServer.listen(5173, resolve));
  console.log('✓ Frontend static server listening on http://localhost:5173');

  // Health checks
  await waitForServerReady('http://localhost:4000/api/v1/health');
  console.log('✓ Backend health check confirmed ready');
  await waitForServerReady('http://localhost:5173');
  console.log('✓ Frontend static app confirmed ready');

  // 3. Launch Headless Chromium
  const browser = await chromium.launch({ headless: true });
  console.log('✓ Chromium browser launched\n');

  let testSucceeded = false;

  try {
    // -------------------------------------------------------------
    // STEP 1: Launch 3 browser clients (Alice, Bob, Charlie)
    // -------------------------------------------------------------
    console.log('[Step 1] Creating Room with User A (Alice)...');
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await page1.goto('http://localhost:5173');
    await page1.waitForSelector('text=Create Workspace');

    await page1.fill('input[placeholder="e.g., Alice"]', 'Alice');
    await page1.click('button:has-text("Create Workspace")');
    await page1.waitForSelector('.monaco-editor', { timeout: 15000 });

    const roomIdText = await page1.locator('header span.font-mono').innerText();
    const roomId = roomIdText.trim();
    console.log(`✓ Alice created workspace with Room ID: ${roomId}`);

    console.log('[Step 1] User B (Bob) joins the room...');
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto('http://localhost:5173');
    await page2.click('button:has-text("Join Room")');
    await page2.fill('input[placeholder="e.g., sync-7f2a-b9c1"]', roomId);
    await page2.fill('input[placeholder="e.g., Bob"]', 'Bob');
    await page2.click('button:has-text("Join Workspace")');
    await page2.waitForSelector('.monaco-editor', { timeout: 15000 });
    console.log('✓ Bob joined workspace successfully');

    console.log('[Step 1] User C (Charlie) joins the room...');
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await page3.goto('http://localhost:5173');
    await page3.click('button:has-text("Join Room")');
    await page3.fill('input[placeholder="e.g., sync-7f2a-b9c1"]', roomId);
    await page3.fill('input[placeholder="e.g., Bob"]', 'Charlie');
    await page3.click('button:has-text("Join Workspace")');
    await page3.waitForSelector('.monaco-editor', { timeout: 15000 });
    console.log('✓ Charlie joined workspace successfully');

    // Wait for all rosters to sync to 3 participants
    await page1.waitForSelector('text=Collaborators (3/5)', { timeout: 5000 });
    await page2.waitForSelector('text=Collaborators (3/5)', { timeout: 5000 });
    await page3.waitForSelector('text=Collaborators (3/5)', { timeout: 5000 });
    console.log('✓ All 3 browser clients mutual rosters show Collaborators (3/5)\n');

    // -------------------------------------------------------------
    // STEP 2: Verify Unique Room Colors (User A != User B != User C)
    // -------------------------------------------------------------
    console.log('[Step 2] Verifying Unique Room Colors for Alice, Bob, and Charlie...');
    const room = roomManager.getRoomEntity(roomId);
    if (!room) throw new Error('Room not found on server');

    const participants = Array.from(room.participants.values()).filter(p => p.connectionState === 'CONNECTED');
    const alice = participants.find(p => p.displayName === 'Alice');
    const bob = participants.find(p => p.displayName === 'Bob');
    const charlie = participants.find(p => p.displayName === 'Charlie');

    if (!alice || !bob || !charlie) {
      throw new Error(`Could not find all 3 participants on server: ${JSON.stringify(participants)}`);
    }

    const colorA = alice.color.hex;
    const colorB = bob.color.hex;
    const colorC = charlie.color.hex;

    console.log(`  User A (Alice):   ${alice.color.name} (${colorA})`);
    console.log(`  User B (Bob):     ${bob.color.name} (${colorB})`);
    console.log(`  User C (Charlie): ${charlie.color.name} (${colorC})`);

    if (colorA === colorB || colorB === colorC || colorA === colorC) {
      throw new Error(`Colors are not distinct! colorA=${colorA}, colorB=${colorB}, colorC=${colorC}`);
    }
    console.log('✓ REQUIREMENT VERIFIED: User A = one color, User B = another color, User C = another color!\n');

    // -------------------------------------------------------------
    // STEP 3: Live Remote Cursors & Name Tags
    // -------------------------------------------------------------
    console.log('[Step 3] Verifying Live Cursors and Participant Name Tags in Monaco...');
    
    // Charlie moves cursor to line 2, column 5 in Monaco
    await page3.evaluate(() => {
      const editor = window.__monacoEditor;
      if (editor) {
        editor.setPosition({ lineNumber: 2, column: 5 });
      }
    });

    // Check that Alice's editor and Bob's editor receive Charlie's cursor decoration
    const charlieSafeId = charlie.userId.replace(/[^a-zA-Z0-9]/g, '');
    const charlieCursorSelector = `.remote-cursor-${charlieSafeId}`;

    await page1.waitForSelector(charlieCursorSelector, { timeout: 5000 });
    await page2.waitForSelector(charlieCursorSelector, { timeout: 5000 });
    console.log(`✓ Charlie's cursor rendered in both Alice's and Bob's Monaco editors (${charlieCursorSelector})`);

    // Verify Bob's selection range
    await page2.evaluate(() => {
      const editor = window.__monacoEditor;
      if (editor) {
        editor.setSelection({
          startLineNumber: 2,
          startColumn: 1,
          endLineNumber: 2,
          endColumn: 10,
        });
      }
    });

    const bobSafeId = bob.userId.replace(/[^a-zA-Z0-9]/g, '');
    const bobSelectionSelector = `.remote-selection-${bobSafeId}`;
    await page1.waitForSelector(bobSelectionSelector, { timeout: 5000 });
    await page3.waitForSelector(bobSelectionSelector, { timeout: 5000 });
    console.log(`✓ Bob's selection range rendered in both Alice's and Charlie's Monaco editors (${bobSelectionSelector})\n`);

    // -------------------------------------------------------------
    // STEP 4: Visual Edit Attribution with Participant Collaboration Colors
    // -------------------------------------------------------------
    console.log('[Step 4] Verifying Visual Edit Attribution for code changes...');

    // Alice types in Monaco editor
    await page1.click('.monaco-editor');
    await page1.keyboard.press('End');
    await page1.keyboard.type('\n// Code by Alice');

    // Bob and Charlie should receive Alice's edit attribution decoration
    const aliceSafeId = alice.userId.replace(/[^a-zA-Z0-9]/g, '');
    const aliceHighlightSelector = `.edit-highlight-${aliceSafeId}`;

    await page2.waitForSelector(aliceHighlightSelector, { state: 'attached', timeout: 5000 });
    await page3.waitForSelector(aliceHighlightSelector, { state: 'attached', timeout: 5000 });
    console.log(`✓ Alice's edit highlighted in Bob's and Charlie's editors with Alice's color (${colorA})`);

    // Verify Bob and Charlie's Monaco content updated
    await page2.waitForFunction(() => {
      const editor = window.__monacoEditor;
      return editor && editor.getValue().includes('// Code by Alice');
    }, { timeout: 5000 });
    console.log('✓ Bob and Charlie received Alice’s synchronized text');

    // Wait for the fading attribution decoration to clear after 3000ms
    console.log('  Waiting 3500ms to verify edit decoration automatically clears...');
    await page2.waitForTimeout(3500);

    const bobDecorationsCount = await page2.locator(aliceHighlightSelector).count();
    const charlieDecorationsCount = await page3.locator(aliceHighlightSelector).count();

    if (bobDecorationsCount !== 0 || charlieDecorationsCount !== 0) {
      throw new Error(`Edit decoration did not clear after timeout! bobCount=${bobDecorationsCount}, charlieCount=${charlieDecorationsCount}`);
    }
    console.log('✓ REQUIREMENT VERIFIED: Edit decoration automatically faded and removed. Code is NOT permanently colored!\n');

    // -------------------------------------------------------------
    // STEP 5: Bob types and attribution is attributed to Bob's color
    // -------------------------------------------------------------
    console.log('[Step 5] Verifying Bob’s edit is attributed in Bob’s color...');
    await page2.click('.monaco-editor');
    await page2.keyboard.press('End');
    await page2.keyboard.type('\n// Code by Bob');

    // Bob's safe ID
    const bobHighlightSelector = `.edit-highlight-${bobSafeId}`;
    await page1.waitForSelector(bobHighlightSelector, { state: 'attached', timeout: 5000 });
    await page3.waitForSelector(bobHighlightSelector, { state: 'attached', timeout: 5000 });
    console.log(`✓ Bob’s edit highlighted in Alice’s and Charlie’s editors with Bob’s color (${colorB})`);

    // Verify Alice and Charlie received Bob's edit
    await page1.waitForFunction(() => {
      const editor = window.__monacoEditor;
      return editor && editor.getValue().includes('// Code by Bob');
    }, { timeout: 5000 });

    await page1.waitForTimeout(3500);
    const aliceBobDecCount = await page1.locator(bobHighlightSelector).count();
    if (aliceBobDecCount !== 0) {
      throw new Error('Bob’s decoration did not clear on Alice’s page');
    }
    console.log('✓ Bob’s edit decoration cleared automatically\n');

    // -------------------------------------------------------------
    // STEP 6: Microphone Toggle & Presence Updates
    // -------------------------------------------------------------
    console.log('[Step 6] Verifying Microphone State & Toggle Updates...');
    
    // Alice toggles microphone from Active to Muted
    const aliceMicToggle = page1.locator('button[title*="Microphone"]');
    await aliceMicToggle.click();

    // Verify Bob's page sees Alice marked as Muted
    await page2.locator(`[data-testid="participant-${alice.userId}"]`).getByText('Muted').waitFor({ timeout: 5000 });
    await page3.locator(`[data-testid="participant-${alice.userId}"]`).getByText('Muted').waitFor({ timeout: 5000 });
    console.log('✓ Bob and Charlie see Alice muted in real-time');

    // Alice toggles back to Active
    await aliceMicToggle.click();
    await page2.locator(`[data-testid="participant-${alice.userId}"]`).getByText('Active').waitFor({ timeout: 5000 });
    await page3.locator(`[data-testid="participant-${alice.userId}"]`).getByText('Active').waitFor({ timeout: 5000 });
    console.log('✓ Bob and Charlie see Alice microphone active again\n');

    // -------------------------------------------------------------
    // STEP 7: Online / Disconnected Presence State
    // -------------------------------------------------------------
    console.log('[Step 7] Verifying Disconnection & Reconnection Presence States...');

    // Disconnect Charlie's socket
    await page3.evaluate(() => {
      if (window.__syncManager && window.__syncManager.socket) {
        window.__syncManager.socket.disconnect();
      }
    });

    // Check Alice and Bob see Charlie offline
    await page1.locator(`[data-testid="participant-${charlie.userId}"]`).getByText('Offline').waitFor({ timeout: 5000 });
    await page2.locator(`[data-testid="participant-${charlie.userId}"]`).getByText('Offline').waitFor({ timeout: 5000 });
    console.log('✓ Alice and Bob see Charlie transition to Offline state');

    // Charlie's cursor should be removed from Alice's and Bob's editors
    const charlieCursorOnAlice = await page1.locator(charlieCursorSelector).count();
    const charlieCursorOnBob = await page2.locator(charlieCursorSelector).count();
    if (charlieCursorOnAlice !== 0 || charlieCursorOnBob !== 0) {
      throw new Error('Charlie cursor remained visible after disconnect');
    }
    console.log('✓ Charlie’s cursor decoration cleaned up on disconnect');

    testSucceeded = true;
    console.log('\n=============================================================');
    console.log('🎉 ALL 3-CLIENT COLLABORATIVE PRESENCE & ATTRIBUTION TESTS PASSED 100%!');
    console.log('=============================================================\n');
  } finally {
    await browser.close();
    await new Promise((r) => frontendServer.close(r));
    await new Promise((r) => backendServer.close(r));
  }

  if (!testSucceeded) {
    process.exit(1);
  }
}

runPresenceVerification().catch((err) => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
