import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeCredentials,
  loadCredentialsFromFile,
  loadCredentials,
  discoverCredentialsFromDoubaoApp,
  CREDENTIALS_FILE_ENV,
} from '../credentials.js'

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

test('normalizeCredentials 校验与归一', () => {
  const ok = normalizeCredentials({
    cookie: ' sessionid=abc; sid_tt=x ',
    device_id: 'dev-1',
    webId: 'web-2',
    tea_uuid: 'tea-3',
    local_app_id: '',
  })
  assert.equal(ok.cookie, 'sessionid=abc; sid_tt=x')
  assert.equal(ok.deviceId, 'dev-1')
  assert.equal(ok.webId, 'web-2')
  assert.equal(ok.teaUuid, 'tea-3')
  assert.equal(ok.localAppId, '582478')
  assert.equal(normalizeCredentials({ cookie: 'ttwid=only' }), undefined)
  assert.equal(normalizeCredentials({ cookie: '' }), undefined)
  assert.equal(normalizeCredentials({}), undefined)
  assert.equal(normalizeCredentials(undefined), undefined)
})

test('loadCredentialsFromFile 好文件/坏文件', () => {
  const good = tmpFile('credentials.json', JSON.stringify({ cookie: 'sessionid=ok', device_id: 'd' }))
  const found = loadCredentialsFromFile(good)
  assert.equal(found.cookie, 'sessionid=ok')
  assert.equal(loadCredentialsFromFile(tmpFile('bad.json', '{ not json')), undefined)
  assert.equal(loadCredentialsFromFile(path.join(os.tmpdir(), '不存在', 'x.json')), undefined)
})

test('loadCredentials 环境变量优先', () => {
  const a = tmpFile('a.json', JSON.stringify({ cookie: 'sessionid=A' }))
  const b = tmpFile('b.json', JSON.stringify({ cookie: 'sessionid=B' }))
  const env = { [CREDENTIALS_FILE_ENV]: a }
  assert.equal(loadCredentials({ credentialsFile: b, autoDiscover: false, env }).cookie, 'sessionid=A')
  assert.equal(loadCredentials({ credentialsFile: b, autoDiscover: false, env: {} }).cookie, 'sessionid=B')
})

test('loadCredentials 无凭据且关闭自动发现 → undefined', () => {
  const env = { [CREDENTIALS_FILE_ENV]: path.join(os.tmpdir(), '不存在', 'x.json') }
  assert.equal(loadCredentials({ credentialsFile: '', autoDiscover: false, env }), undefined)
})

test('loadCredentials 环境变量指向坏文件时回落下一候选', () => {
  const b = tmpFile('b.json', JSON.stringify({ cookie: 'sessionid=B' }))
  const env = { [CREDENTIALS_FILE_ENV]: path.join(os.tmpdir(), '不存在', 'x.json') }
  assert.equal(loadCredentials({ credentialsFile: b, autoDiscover: false, env }).cookie, 'sessionid=B')
})

test('discoverCredentialsFromDoubaoApp 对象形态', () => {
  const state = {
    saman: {
      local_storage_app_for_web: {
        enterprise: { 'x-tt-multi-sids': encodeURIComponent('111:mysid|222:othersid') },
      },
    },
    aha: { device: { device_id: 'dev-9', install_id: 'inst-7' } },
  }
  const file = tmpFile('Local State', JSON.stringify(state))
  const found = discoverCredentialsFromDoubaoApp(file)
  assert.equal(found.cookie, 'sessionid=mysid; sessionid_ss=mysid')
  assert.equal(found.deviceId, 'dev-9')
  assert.equal(found.teaUuid, 'inst-7')
  assert.equal(found.localAppId, '582478')
})

test('discoverCredentialsFromDoubaoApp 转义字符串形态', () => {
  const state = {
    saman: {
      local_storage_app_for_web: {
        enterprise: JSON.stringify({ 'x-tt-multi-sids': 'sid-str' }),
      },
    },
  }
  const file = tmpFile('Local State', JSON.stringify(state))
  const found = discoverCredentialsFromDoubaoApp(file)
  assert.equal(found.cookie, 'sessionid=sid-str; sessionid_ss=sid-str')
})

test('discoverCredentialsFromDoubaoApp 缺失/坏文件 → undefined', () => {
  assert.equal(discoverCredentialsFromDoubaoApp(path.join(os.tmpdir(), '不存在-x')), undefined)
  const empty = tmpFile('Local State', JSON.stringify({ saman: {} }))
  assert.equal(discoverCredentialsFromDoubaoApp(empty), undefined)
})
