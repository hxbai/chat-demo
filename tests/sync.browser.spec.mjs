import { test, expect } from '@playwright/test'
import { fixture, session } from './pocketbase.integration.test.mjs'

async function signIn(context, url, key = 'test-device-key') {
  await context.addInitScript((apiKey) => {
    localStorage.setItem('chat-demo:api-key', apiKey)
    localStorage.setItem('chat-demo:locale', 'en-US')
  }, key)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test')
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-primary-user')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  return page
}
async function rename(page, title) {
  await page.getByRole('button', { name: 'More', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.locator('input[class*="renameInput"]')
  await input.fill(title)
  await input.press('Enter')
}
async function records(pb) {
  return pb.collection('chat_sessions').getFullList({ filter: 'deleted=false' })
}

test('Two devices sync branches, recover offline edits, and preserve conflicts as copies', async ({
  browser,
}) => {
  const f = await fixture()
  const first = await browser.newContext()
  const second = await browser.newContext()
  try {
    await f.client.send('/api/ds-chat/save', {
      method: 'POST',
      body: { session: session(), revision: 0 },
    })
    const laptop = await signIn(first, f.url, 'laptop-only-key')
    const phone = await signIn(second, f.url, 'phone-only-key')
    await laptop.getByText('Shared history', { exact: true }).click()
    await phone.getByText('Shared history', { exact: true }).click()
    await expect(laptop.getByText('Alternate answer', { exact: true })).toBeVisible()
    await expect(phone.getByText('Alternate answer', { exact: true })).toBeVisible()
    await rename(laptop, 'Renamed on laptop')
    await expect(phone.getByText('Renamed on laptop', { exact: true }).first()).toBeVisible({
      timeout: 12000,
    })
    {
      expect(await laptop.evaluate(() => localStorage.getItem('chat-demo:api-key'))).toBe(
        'laptop-only-key'
      )
      expect(await phone.evaluate(() => localStorage.getItem('chat-demo:api-key'))).toBe(
        'phone-only-key'
      )
      expect(JSON.stringify(await records(f.client))).not.toContain('laptop-only-key')
    }
    // An offline rename remains durable in IndexedDB even across a page reload.
    await first.setOffline(true)
    await rename(laptop, 'Offline laptop version')
    await expect(
      laptop.getByText('Offline · changes stay on this device until saved', { exact: true })
    ).toBeVisible()
    const pending = await laptop.evaluate(async () => {
      const auth = JSON.parse(localStorage.getItem('pocketbase_auth'))
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`ds-chat-recovery-${auth.record.id}`)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return new Promise((resolve) => {
        const request = db.transaction('pending').objectStore('pending').getAll()
        request.onsuccess = () => resolve(request.result)
      })
    })
    expect(pending[0].session.title).toBe('Offline laptop version')
    // The other device changes the same revision while the laptop is disconnected.
    await rename(phone, 'Phone wins original')
    await expect
      .poll(async () => (await records(f.client))[0].summary.title)
      .toBe('Phone wins original')
    await first.setOffline(false)
    await laptop.reload()
    await expect(laptop.getByText('Offline laptop version', { exact: true }).first()).toBeVisible()
    await expect(laptop.getByText('History has unsaved changes', { exact: true })).toBeVisible()
    await laptop
      .getByRole('button', { name: 'Save conflicting chats as copies', exact: true })
      .click()
    await expect.poll(async () => (await records(f.client)).length).toBe(2)
    const saved = await records(f.client)
    expect(saved.some((r) => r.summary.title === 'Phone wins original')).toBe(true)
    const copy = saved.find((r) => r.summary.title === 'Offline laptop version (conflict copy)')
    expect(copy.payload.messages).toHaveLength(3)
    await expect(
      phone.getByText('Offline laptop version (conflict copy)', { exact: true }).first()
    ).toBeVisible({ timeout: 12000 })
    // Responsive layout keeps synced content available on a phone-sized screen.
    await phone.getByText('Offline laptop version (conflict copy)', { exact: true }).first().click()
    await phone.setViewportSize({ width: 390, height: 844 })
    await expect(phone.getByText('Alternate answer', { exact: true })).toBeVisible()
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  } finally {
    await first.close()
    await second.close()
    await f.close()
  }
})

test('Sending a chat with an image syncs to another device and round-trips through ZIP import', async ({
  browser,
}) => {
  const f = await fixture()
  const first = await browser.newContext()
  const second = await browser.newContext()
  try {
    // Mock only the external inference service; all history/file requests hit real PocketBase.
    const events = [
      { type: 'message_start', message: { id: 'mock-reply', model: 'deepseek-flash' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'A reply saved on your server.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, title: 'Image chat' },
      },
      { type: 'message_stop' },
    ]
    await first.route('https://api.deepseek.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
        })
      if (route.request().url().endsWith('/files'))
        return route.fulfill({
          json: {
            id: 'mock-image-file',
            type: 'file',
            size_bytes: 68,
            filename: 'pixel.png',
            mime_type: 'image/png',
          },
        })
      return route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*' },
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      })
    })
    const laptop = await signIn(first, f.url)
    const phone = await signIn(second, f.url)
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6NtwAAAAASUVORK5CYII=',
      'base64'
    )
    await laptop
      .locator('input[type=file]')
      .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image })
    await laptop
      .getByRole('textbox', { name: 'Enter a message' })
      .fill('Please describe this image.')
    await expect(laptop.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await laptop.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(laptop.getByText('A reply saved on your server.', { exact: true })).toBeVisible()
    await expect
      .poll(async () => (await records(f.client))[0]?.payload.messages.at(-1).status)
      .toBe('done')
    await expect
      .poll(async () => (await f.client.collection('chat_files').getFullList()).length)
      .toBe(1)
    await expect(phone.getByText('Image chat', { exact: true })).toBeVisible({ timeout: 12000 })
    await phone.getByText('Image chat', { exact: true }).click()
    await expect(phone.getByText('A reply saved on your server.', { exact: true })).toBeVisible()
    const syncedImage = phone.locator('img[src^="blob:"]').first()
    await expect(syncedImage).toBeVisible()
    expect(await syncedImage.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true)
    await laptop.getByRole('button', { name: 'Settings', exact: true }).click()
    await laptop.getByRole('tab', { name: 'Data', exact: true }).click()
    const downloadPromise = laptop.waitForEvent('download')
    await laptop.getByRole('button', { name: 'Download', exact: true }).click()
    const download = await downloadPromise
    const archive = await download.path()
    // Clear server history, then import the app's own ZIP to exercise tombstone restore.
    const current = await records(f.client)
    await f.client.send('/api/ds-chat/replace', {
      method: 'POST',
      body: { sessions: [], expected: current.map((r) => ({ sid: r.sid, revision: r.revision })) },
    })
    await expect(laptop.getByText('Image chat', { exact: true })).toHaveCount(0, { timeout: 12000 })
    await laptop.locator('input[accept*=".zip"]').setInputFiles(archive)
    await laptop.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(laptop.getByText('Imported 1 chat', { exact: true })).toBeVisible()
    await expect.poll(async () => (await records(f.client)).length).toBe(1)
    expect((await records(f.client))[0].payload.messages[0].content).toBe(
      'Please describe this image.'
    )
    expect((await records(f.client))[0].payload.messages.at(-1).model).toBe('deepseek-flash')
    expect((await records(f.client))[0].payload.messages.at(-1).reasoningEffort).toBe('high')
    await expect(phone.getByText('Image chat', { exact: true }).first()).toBeVisible({
      timeout: 12000,
    })
  } finally {
    await first.close()
    await second.close()
    await f.close()
  }
})

test('Model and effort selections persist, reach the API, and stay attached to continued replies', async ({
  browser,
}) => {
  const f = await fixture()
  const context = await browser.newContext()
  const requests = []
  try {
    await context.route('https://api.deepseek.com/**', async (route) => {
      requests.push(route.request().postDataJSON())
      const events = [
        { type: 'message_start', message: { id: 'model-test', model: requests.at(-1).model } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: `Reply ${requests.length}` },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: {
            stop_reason: requests.length === 1 ? 'max_tokens' : 'end_turn',
            stop_sequence: null,
          },
        },
        { type: 'message_stop' },
      ]
      await route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*' },
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      })
    })
    const page = await signIn(context, f.url)
    const choose = async (section, option) => {
      await page.getByRole('button', { name: 'Model and reasoning', exact: true }).click()
      await page.getByRole('menuitem', { name: new RegExp(`^${section}`) }).click()
      await page.getByRole('menuitemradio', { name: new RegExp(`^${option}`) }).click()
    }
    const send = async (text, count) => {
      await page.getByRole('textbox', { name: 'Enter a message' }).fill(text)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => requests.length).toBe(count)
      await expect
        .poll(async () => (await records(f.client))[0]?.payload.messages.at(-1).status)
        .toBe('done')
      await expect(
        page.getByRole('button', { name: 'Model and reasoning', exact: true })
      ).toBeEnabled()
    }
    await choose('Model', 'DeepSeek V4 Pro')
    await choose('Effort', 'Max')
    await page.reload()
    const picker = page.getByRole('button', { name: 'Model and reasoning', exact: true })
    await expect(picker).toContainText('DeepSeek V4 Pro')
    await expect(picker).toContainText('Max')
    await send('Test maximum effort', 1)
    expect(requests[0].model).toBe('deepseek-v4-pro')
    expect(requests[0].safety_check).toEqual({ level: 'low' })
    expect(requests[0].output_config).toEqual({ effort: 'max' })
    expect(requests[0].thinking).toEqual({ type: 'enabled' })
    expect((await records(f.client))[0].payload.messages.at(-1).reasoningEffort).toBe('max')
    await choose('Model', 'DeepSeek Flash')
    await choose('Effort', 'Low')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => requests.length).toBe(2)
    await expect(picker).toBeEnabled()
    expect(requests[1].model).toBe('deepseek-v4-pro')
    expect(requests[1].output_config).toEqual({ effort: 'max' })
    await send('Now use low effort', 3)
    expect(requests[2].model).toBe('deepseek-flash')
    expect(requests[2].output_config).toEqual({ effort: 'low' })
    await choose('Effort', 'Off')
    await send('No reasoning', 4)
    expect(requests[3].thinking).toEqual({ type: 'disabled' })
    expect(requests[3]).not.toHaveProperty('output_config')
    await choose('Effort', 'High')
    await page.getByRole('button', { name: 'DeepThink', exact: true }).click()
    await expect(picker).toContainText('Off')
    await page.getByRole('button', { name: 'DeepThink', exact: true }).click()
    await expect(picker).toContainText('High')
    await send('High reasoning again', 5)
    expect(requests[4].output_config).toEqual({ effort: 'high' })
    await page.setViewportSize({ width: 390, height: 844 })
    await picker.click()
    const menu = page.getByRole('menu', { name: 'Model and reasoning', exact: true })
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  } finally {
    await context.close()
    await f.close()
  }
})

test('Project folders sync, contain new chats, and keep chats when deleted', async ({
  browser,
}) => {
  const f = await fixture()
  const context = await browser.newContext()
  const second = await browser.newContext()
  try {
    await f.client.send('/api/ds-chat/save', {
      method: 'POST',
      body: { session: session(), revision: 0 },
    })
    await context.route('https://api.deepseek.com/**', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'access-control-allow-origin': '*' },
        body: [
          { type: 'message_start', message: { id: 'reply', model: 'deepseek-flash' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', title: 'Folder chat' } },
          { type: 'message_stop' },
        ]
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
      })
    )
    const page = await signIn(context, f.url)
    const phone = await signIn(second, f.url)
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Research')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'New chat in Research', exact: true })
    ).toBeVisible()
    await expect(
      phone.getByRole('button', { name: 'New chat in Research', exact: true })
    ).toBeVisible({ timeout: 12000 })
    const [project] = await f.client.collection('chat_projects').getFullList()
    await page.reload()
    await page.getByRole('button', { name: 'New chat in Research', exact: true }).click()
    await page.getByRole('textbox', { name: 'Enter a message' }).fill('A chat inside this folder')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await records(f.client))
            .find((r) => r.payload.projectId === project.id)
            ?.payload.messages.at(-1)?.status
      )
      .toBe('done')
    expect(
      (await records(f.client)).find((r) => r.payload.projectId === project.id).summary.projectId
    ).toBe(project.id)
    // Move an existing conversation using its menu.
    const existing = page.getByText('Shared history', { exact: true }).locator('..')
    await existing.hover()
    await existing.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to folder', exact: true }).click()
    await page.getByRole('combobox', { name: 'Move to folder' }).selectOption(project.id)
    await page.getByRole('button', { name: 'Move chat', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await records(f.client)).find((r) => r.sid === 'test-conversation').summary.projectId
      )
      .toBe(project.id)
    await page.getByRole('button', { name: 'Rename folder: Research', exact: true }).click()
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Work')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New chat in Work', exact: true })).toBeVisible()
    await expect(phone.getByRole('button', { name: 'New chat in Work', exact: true })).toBeVisible({
      timeout: 12000,
    })
    await page.getByRole('button', { name: 'Delete folder: Work', exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New chat in Work', exact: true })).toHaveCount(0)
    await expect(page.getByText('Shared history', { exact: true })).toBeVisible()
    expect(await records(f.client)).toHaveLength(2)
    await page.reload()
    await expect(page.getByText('Shared history', { exact: true })).toBeVisible()
  } finally {
    await second.close()
    await context.close()
    await f.close()
  }
})
