'use strict'
/**
 * chiheng-bridge —— 赤轨 × DeepSeek HARNESS 桥接插件（@deepseek-ai/dsh@0.2.1-rc.2，最小骨架 v2）
 *
 * 方向（关键）：赤轨（宿主）把上下文（账本 / 行情 / 因子判决）通过 HTTP POST 推进来，
 * DSH 用自身的 llm 服务生成输出，赤轨拿回后仍走自己的硬闸（red-line.ts / number-gate.ts /
 * factor-expr.ts）—— AI 依旧只许「提议」，判决逻辑写死在赤轨代码里。
 *
 * 已按 0.2.1-rc.2 实测核对（解包 dsh-llm / dsh-host-webserver / dsh-agent-default-model 源码）：
 *   - webServer 服务：register({ kind: 'exact'|'prefix', path, handler }) ，handler(req, res)
 *   - llm 服务：stream({ provider, model, messages, system?, temperature?, maxTokens? })
 *     · provider / model 必填；messages 是 { id, role, content:[{type:'text',text}], source:{kind} }
 *   - 流块：type === 'text-delta' | 'reasoning-delta'（携带 .text）
 *   - agentDefaultModel 服务仍在：currentSelection() → { provider, model, reasoningEffort? }
 *     （0.1.0-rc.6 → 0.2.1-rc.2 未改名；其服务名用 super(ownerContext, "agentDefaultModel") 声明）
 *
 * 路由（挂在 DSH 的 webServer 上，默认 :3080）：
 *   GET  /chihengapi/health    { ok: true, provider, model }
 *   POST /chihengapi/chat      { provider?, model?, system?, context?, user } → { ok, text, empty }
 *
 * 后续扩展（跑通后再加）：
 *   - /chihengapi/agent  用 subprocess 服务拉起 headless agent（dsh --profile headless "job"）
 *   - /chihengapi/vt-tools  把 Vibe-Trading MCP 工具矿山 stdio 包成 HTTP，给 DSH agent 当工具
 */
module.exports = {
  inject: ['webServer'],
  apply(ctx) {
    const llm = ctx.get('llm')
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const FALLBACK = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    function sendJson(res, code, obj) {
      const body = JSON.stringify(obj)
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS))
      res.end(body)
    }

    function readBody(req) {
      return new Promise(function (resolve, reject) {
        let body = ''
        req.setEncoding('utf-8')
        req.on('data', function (c) { body += c })
        req.on('end', function () {
          try { resolve(JSON.parse(body || '{}')) } catch (e) { reject(e) }
        })
        req.on('error', reject)
      })
    }

    function uid() {
      return 'chiheng-' + Math.random().toString(36).slice(2, 10)
    }

    async function currentSelection() {
      try {
        if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
          const sel = await agentDefaultModel.currentSelection()
          if (sel && sel.provider) return { provider: sel.provider, model: sel.model || FALLBACK.model }
        }
      } catch (e) { /* 回退 */ }
      return FALLBACK
    }

    ctx.effect(function () {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/chihengapi',
        handler: async function (req, res) {
          const pathname = String(req.url || '').split('?')[0]
          try {
            if (req.method === 'OPTIONS') {
              res.writeHead(204, CORS)
              return res.end()
            }

            if (req.method === 'GET' && pathname === '/chihengapi/health') {
              const sel = await currentSelection()
              return sendJson(res, 200, { ok: true, provider: sel.provider, model: sel.model })
            }

            if (req.method === 'POST' && pathname === '/chihengapi/chat') {
              const body = await readBody(req)
              const sel = await currentSelection()
              const provider = String(body.provider || sel.provider)
              const model = String(body.model || sel.model)
              const sys = String(body.system || '')
              const ctxText = String(body.context || '')
              const user = String(body.user || '').trim()
              if (!user) return sendJson(res, 400, { ok: false, error: 'need user' })
              if (!llm || typeof llm.stream !== 'function') {
                return sendJson(res, 503, { ok: false, error: 'llm 服务不可用' })
              }
              const messages = []
              // 上下文作为一条 user 侧输入，排在用户指令之前；空则跳过。
              if (ctxText) {
                messages.push({
                  id: uid(),
                  role: 'user',
                  content: [{ type: 'text', text: ctxText }],
                  source: { kind: 'user' },
                })
              }
              messages.push({
                id: uid(),
                role: 'user',
                content: [{ type: 'text', text: user }],
                source: { kind: 'user' },
              })
              let out = ''
              let reasoning = ''
              for await (const c of llm.stream({
                provider,
                model,
                messages,
                system: sys || undefined,
                temperature: 0.2,
              })) {
                if (c && c.type === 'text-delta' && c.text) out += c.text
                else if (c && c.type === 'reasoning-delta' && c.text) reasoning += c.text
              }
              out = String(out || '').trim()
              // 正文与思考分离：赤轨要的是干净 JSON 正文，思考（reasoning）单独返回、不进正文，
              // 免得 DeepSeek 推理模型的 chain-of-thought 混进 JSON 把解析搞坏。
              return sendJson(res, 200, {
                ok: true,
                text: out,
                empty: !out,
                reasoning: reasoning.trim() || undefined,
              })
            }

            return sendJson(res, 404, { error: 'chiheng route not found' })
          } catch (e) {
            return sendJson(res, 500, { error: String((e && e.message) || e) })
          }
        },
      })
    })
  },
}
