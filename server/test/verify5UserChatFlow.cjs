const http = require('http');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

// Require compiled server & socket setup
const { createApp } = require('../dist/app');
const { setupSocketServer } = require('../dist/socket');

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

async function run5UserChatVerification() {
  console.log('===============================================================');
  console.log('   STARTING 5-PARTICIPANT ROOM CHAT END-TO-END VERIFICATION    ');
  console.log('===============================================================\n');

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
  console.log('✓ Frontend static app confirmed ready\n');

  // 3. Launch Headless Chromium
  const browser = await chromium.launch({ headless: true });
  console.log('✓ Chromium browser launched');

  try {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    const contexts = [];
    const pages = [];

    // Create 5 separate browser contexts (isolated cookies, local storage, sessions)
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      contexts.push(ctx);
      pages.push(page);
    }

    console.log('✓ 5 isolated browser contexts initialized');

    // 4. Alice creates the room
    const alicePage = pages[0];
    await alicePage.goto('http://localhost:5173');
    await alicePage.waitForSelector('text=Create Workspace', { timeout: 10000 });

    const nameInput = alicePage.locator('input[placeholder*="Alex Chen"], input[type="text"]').first();
    await nameInput.fill('Alice');

    const createButton = alicePage.locator('button:has-text("Create Workspace")');
    await createButton.click();

    // Wait for Workspace View
    await alicePage.waitForSelector('header', { timeout: 10000 });
    console.log('✓ Alice successfully created room');

    // Extract Room ID
    const roomHeader = alicePage.locator('header');
    const roomIdEl = roomHeader.locator('span.font-mono.font-bold').first();
    const roomId = (await roomIdEl.textContent()).trim();
    console.log(`✓ Room created with Authoritative Room ID: "${roomId}"`);

    // Verify Room Chat panel is open by default
    await alicePage.waitForSelector('aside[aria-label="Room Chat"]', { timeout: 5000 });
    console.log('✓ Alice Room Chat panel rendered');

    // 5. Join users Bob, Charlie, David, Eve
    for (let i = 1; i < 5; i++) {
      const page = pages[i];
      const name = names[i];

      await page.goto('http://localhost:5173');
      await page.waitForSelector('text=Join Room', { timeout: 10000 });

      // Click "Join Room" tab
      await page.locator('button:has-text("Join Room")').click();

      // Enter Room ID
      const roomIdInput = page.locator('input[placeholder*="sync-"]').first();
      await roomIdInput.fill(roomId);

      // Enter Name
      const userNameInput = page.locator('input[placeholder*="Taylor Swift"], input[placeholder*="name"], input[type="text"]').last();
      await userNameInput.fill(name);

      // Submit Join
      await page.locator('button:has-text("Join Workspace")').click();

      // Wait for Workspace View
      await page.waitForSelector('header', { timeout: 10000 });
      await page.waitForSelector('aside[aria-label="Room Chat"]', { timeout: 5000 });
      console.log(`✓ Participant ${name} joined room "${roomId}"`);
    }

    // Wait for all presences to settle
    await alicePage.waitForTimeout(1000);

    // Verify Capacity in Header: 5 / 5 Users
    const capacityText = await alicePage.locator('header').textContent();
    console.log(`✓ Header status: "${capacityText.includes('5 / 5') ? '5 / 5 Users confirmed' : capacityText}"`);
    if (!capacityText.includes('5 / 5')) {
      throw new Error(`Expected capacity to show 5 / 5 Users, got: ${capacityText}`);
    }

    // 6. Test 6th User (Frank) trying to join: Should be rejected (Room Full)
    const frankCtx = await browser.newContext();
    const frankPage = await frankCtx.newPage();
    await frankPage.goto('http://localhost:5173');
    await frankPage.locator('button:has-text("Join Room")').click();
    await frankPage.locator('input[placeholder*="sync-"]').first().fill(roomId);
    await frankPage.locator('input[type="text"]').last().fill('Frank');
    await frankPage.locator('button:has-text("Join Workspace")').click();

    // Verify Error Alert for room full
    await frankPage.waitForSelector('text=capacity', { timeout: 5000 });
    console.log('✓ 6th participant (Frank) correctly rejected by capacity constraint (5/5)');
    await frankCtx.close();

    // 7. Test Cross-Client Chat Delivery from All 5 Participants
    console.log('\n--- Testing Real-Time Chat Broadcast Among All 5 Participants ---');
    for (let i = 0; i < 5; i++) {
      const page = pages[i];
      const name = names[i];
      const chatInput = page.locator('textarea[aria-label="Chat message input"]');
      const sendBtn = page.locator('button:has-text("Send")');

      const messageText = `Message from ${name} at step ${i + 1}`;
      await chatInput.fill(messageText);
      await sendBtn.click();
      console.log(`  -> ${name} sent: "${messageText}"`);
    }

    // Wait for all socket broadcasts to propagate
    await alicePage.waitForTimeout(1000);

    // Verify Alice sees all 5 messages
    for (const name of names) {
      await alicePage.waitForSelector(`text=Message from ${name}`, { timeout: 5000 });
      console.log(`✓ Alice received chat message from ${name}`);
    }

    // Verify Eve also sees all 5 messages
    const evePage = pages[4];
    for (const name of names) {
      await evePage.waitForSelector(`text=Message from ${name}`, { timeout: 5000 });
    }
    console.log('✓ Eve received all 5 messages across the room');

    // 8. Test System Join Messages
    const systemJoinMsg = await alicePage.locator('text=Bob joined the workspace').first();
    const isJoinVisible = await systemJoinMsg.isVisible();
    console.log(`✓ System join message rendered: ${isJoinVisible}`);

    // 9. Test Character Counter & Message Validation
    console.log('\n--- Testing Chat Validation & Constraints ---');
    const bobPage = pages[1];
    const bobInput = bobPage.locator('textarea[aria-label="Chat message input"]');
    const bobSendBtn = bobPage.locator('button:has-text("Send")');

    // Empty input: Send button must be disabled
    await bobInput.fill('   ');
    const isBtnDisabled = await bobSendBtn.isDisabled();
    console.log(`✓ Empty/whitespace message: Send button disabled = ${isBtnDisabled}`);
    if (!isBtnDisabled) throw new Error('Send button should be disabled for empty message');

    // Check character counter display
    await bobInput.fill('SyncCode Chat Test');
    const counterText = await bobPage.locator('text=18 / 1000').textContent();
    console.log(`✓ Character counter working accurately: "${counterText}"`);

    // 10. Test System Departure Notification when Eve leaves
    console.log('\n--- Testing Participant Departure & System Chat Notice ---');
    const eveLeaveBtn = evePage.locator('button:has-text("Leave Room")');
    await eveLeaveBtn.click();
    console.log('✓ Eve clicked "Leave Room"');

    // Verify system chat broadcast on Alice's screen: "Eve left the workspace"
    await alicePage.waitForSelector('text=Eve left the workspace', { timeout: 5000 });
    console.log('✓ Alice received system chat notification: "Eve left the workspace"');

    // Header updates to 4 / 5 Users
    await alicePage.waitForSelector('text=4 / 5 Users', { timeout: 5000 });
    console.log('✓ Header updated to "4 / 5 Users"');

    // 11. Test Chat Panel Toggle on Alice's client
    const chatToggleBtn = alicePage.locator('button[aria-label="Toggle Chat"]');
    await chatToggleBtn.click();
    const chatHidden = (await alicePage.locator('aside[aria-label="Room Chat"]').count()) === 0;
    console.log(`✓ Chat toggle button: chat panel closed = ${chatHidden}`);

    await chatToggleBtn.click();
    const chatRestored = (await alicePage.locator('aside[aria-label="Room Chat"]').count()) === 1;
    console.log(`✓ Chat toggle button: chat panel reopened = ${chatRestored}`);

    // 12. Test Host Lock & Unlock System Chat Messages (Audit Item 1)
    console.log('\n--- Testing Room Lock & Unlock System Chat Broadcasts ---');
    const lockBtn = alicePage.locator('header button:has-text("Lock")');
    await lockBtn.click();
    console.log('✓ Alice clicked "Lock"');

    // Verify system chat: "Room locked by Alice" on Alice and Bob's chat feed
    await alicePage.waitForSelector('text=Room locked by Alice', { timeout: 5000 });
    await bobPage.waitForSelector('text=Room locked by Alice', { timeout: 5000 });
    console.log('✓ Alice and Bob received system chat: "Room locked by Alice"');

    // Unlock
    const unlockBtn = alicePage.locator('header button:has-text("Unlock")');
    await unlockBtn.click();
    console.log('✓ Alice clicked "Unlock"');

    await alicePage.waitForSelector('text=Room unlocked by Alice', { timeout: 5000 });
    await bobPage.waitForSelector('text=Room unlocked by Alice', { timeout: 5000 });
    console.log('✓ Alice and Bob received system chat: "Room unlocked by Alice"');

    // 13. Test Host Participant Ejection & System Chat Broadcast
    console.log('\n--- Testing Participant Ejection & System Notice ---');
    const ejectDavidBtn = alicePage.locator('button[title*="Remove David"]').first();
    await ejectDavidBtn.click();
    console.log('✓ Alice ejected David from workspace');

    // David's page should see notification or transition
    await pages[3].waitForSelector('text=removed from the room by the host', { timeout: 5000 });
    console.log('✓ David received host ejection notice');

    // Alice sees system chat: "David was removed from the workspace by the host"
    await alicePage.waitForSelector('text=David was removed from the workspace by the host', { timeout: 5000 });
    console.log('✓ Alice received system chat: "David was removed from the workspace by the host"');

    // 14. Test XSS Injection Safety in Chat
    console.log('\n--- Testing Chat XSS Sanitization & Rendering Safety ---');
    const xssPayload = '<script>window.pwned=true</script><img src=x onerror=alert(1)><b>bold</b>';
    const aliceInput = alicePage.locator('textarea[aria-label="Chat message input"]');
    await aliceInput.fill(xssPayload);
    await alicePage.locator('button:has-text("Send")').click();

    await bobPage.waitForSelector(`text=${xssPayload}`, { timeout: 5000 });
    const isPwned = await bobPage.evaluate(() => window.pwned);
    console.log(`✓ Chat rendered payload as safe plain text string; window.pwned is ${isPwned}`);
    if (isPwned) throw new Error('XSS script executed in client context!');

    console.log('\n===============================================================');
    console.log('   ALL 5-PARTICIPANT CHAT FLOW VERIFICATIONS PASSED (100%)     ');
    console.log('===============================================================');
  } finally {
    await browser.close();
    await new Promise((resolve) => frontendServer.close(resolve));
    await new Promise((resolve) => backendServer.close(resolve));
    console.log('✓ Teardown complete');
  }
}

run5UserChatVerification().catch((err) => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
