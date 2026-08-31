import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"
import { resetResponseIntegrityForTests, sanitizeResponseText } from "../response-integrity"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
  test("inserts post-rollover message events by creation time rather than ID", () => {
    const legacy = {
      id: "msg_ffffffffffffLegacy",
      sessionID: "ses_1",
      role: "user",
      time: { created: 100 },
    } as Message
    const current = {
      id: "msg_000000000000Current",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 200 },
    } as Message
    const draft = state({ message: { ses_1: [legacy] } })

    expect(applyDirectoryEvent(draft, {
      type: "message.updated",
      properties: { info: current },
    } as Event)).toBe(true)
    expect(draft.message.ses_1).toEqual([legacy, current])
  })

  test("preserves part event order across the part ID rollover", () => {
    const legacyPart = {
      id: "prt_ffffffffffffLegacy",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "legacy",
    } as Part
    const currentPart = {
      id: "prt_000000000000Current",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "current",
    } as Part
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [legacyPart] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: { part: currentPart },
    } as Event)).toBe(true)
    expect(draft.part.msg_1).toEqual([legacyPart, currentPart])
  })

  test("replaces an optimistic user part in place instead of appending it", () => {
    const optimisticText = { id: "prt_optimistic_text", messageID: "msg_1", type: "text", text: "hi" } as Part
    const optimisticFile = { id: "prt_optimistic_file", messageID: "msg_1", type: "file", filename: "a.png" } as Part
    const serverText = { id: "prt_server_text", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hi" } as Part
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message] },
      part: { msg_1: [optimisticText, optimisticFile] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: { part: serverText },
    } as Event)).toBe(true)
    expect(draft.part.msg_1).toEqual([serverText, optimisticFile])
  })

  test("preserves legal prose containing pollution-like words", () => {
    resetResponseIntegrityForTests()
    const legalText = "The API returned invalid. The selector >xpath is documented, and Baebele is a proper name."
    expect(sanitizeResponseText(legalText)).toEqual({ text: legalText, polluted: false, internalLeak: false })
  })

  test("requires a sentence boundary before a pollution tail", () => {
    resetResponseIntegrityForTests()
    expect(sanitizeResponseText("讨论六合彩的历史。这里没有广告内容。")).toEqual({
      text: "讨论六合彩的历史。这里没有广告内容。",
      polluted: false,
      internalLeak: false,
    })
  })

  test("preserves normal English control-flow prose", () => {
    resetResponseIntegrityForTests()
    const legalText = "The build failed. No final artifact was generated, so stop the export and review the logs."
    expect(sanitizeResponseText(legalText)).toEqual({ text: legalText, polluted: false, internalLeak: false })
  })

  test("does not classify a standalone legal control-flow sentence as an internal leak", () => {
    resetResponseIntegrityForTests()
    expect(sanitizeResponseText("Stop.")).toEqual({ text: "", polluted: true, internalLeak: false })
    expect(sanitizeResponseText("[END]")).toEqual({ text: "", polluted: true, internalLeak: false })
  })

  test("filters an internal-loop leak without persisting the assistant message", () => {
    resetResponseIntegrityForTests()
    const draft = state({
      message: { ses_1: [{ id: "msg_leak", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
      part: { msg_leak: [{ id: "prt_leak", messageID: "msg_leak", sessionID: "ses_1", type: "text", text: "I failed.\nThis is clearly a system loop.\nNo final." } as Part] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: draft.part.msg_leak[0] },
    } as Event)).toBe(true)
    expect(draft.message.ses_1).toEqual([])
    expect(draft.part.msg_leak).toBe(undefined)

    expect(applyDirectoryEvent(draft, {
      type: "message.updated",
      properties: { info: { id: "msg_leak", sessionID: "ses_1", role: "assistant", time: { created: 1 } } },
    } as Event)).toBe(false)
  })

  test("filters an internal-loop leak split across deltas", () => {
    resetResponseIntegrityForTests()
    const draft = state({
      message: { ses_1: [{ id: "msg_leak", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
      part: { msg_leak: [{ id: "prt_leak", messageID: "msg_leak", sessionID: "ses_1", type: "text", text: "状态。" } as Part] },
    })

    expect(applyDirectoryEvent(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_leak", partID: "prt_leak", field: "text", delta: "This is clearly a " } } as Event)).toBe(true)
    expect(applyDirectoryEvent(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_leak", partID: "prt_leak", field: "text", delta: "system loop." } } as Event)).toBe(true)
    expect((draft.part.msg_leak[0] as { text: string }).text).toBe("状态。")
  })

  test("filters known pollution from text deltas", () => {
    resetResponseIntegrityForTests()
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "已完成。" } as Part] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "_久久爱" },
    } as Event)).toBe(false)
    expect((draft.part.msg_1[0] as { text: string }).text).toBe("已完成。")
  })

  test("filters pollution split across deltas", () => {
    resetResponseIntegrityForTests()
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "结果。" } as Part] },
    })

    expect(applyDirectoryEvent(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "geek" } } as Event)).toBe(true)
    expect(applyDirectoryEvent(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "y?" } } as Event)).toBe(true)
    expect((draft.part.msg_1[0] as { text: string }).text).toBe("结果。")
  })

  test("rejects deltas after a completed assistant message", () => {
    resetResponseIntegrityForTests()
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "完成" } as Part] },
    })

    expect(applyDirectoryEvent(draft, deltaEvent())).toBe(false)
    expect((draft.part.msg_1[0] as { text: string }).text).toBe("完成")
  })

  test("removes a repeated completed assistant response", () => {
    resetResponseIntegrityForTests()
    const text = "刚才确实出现了回复重复发送异常，抱歉。实际工作已经完成。"
    const first = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text } as Part] },
    })
    expect(applyDirectoryEvent(first, { type: "message.part.updated", properties: { sessionID: "ses_1", part: first.part.msg_1[0] } } as Event)).toBe(true)

    const second = state({
      message: { ses_1: [
        first.message.ses_1[0],
        { id: "msg_2", sessionID: "ses_1", role: "assistant", finish: "stop", time: { created: 3, completed: 4 } } as never,
      ] },
      part: { msg_2: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text } as Part] },
    })
    expect(applyDirectoryEvent(second, { type: "message.part.updated", properties: { sessionID: "ses_1", part: second.part.msg_2[0] } } as Event)).toBe(true)
    expect(second.message.ses_1.map((message) => message.id)).toEqual(["msg_1"])
  })

  test("does not deduplicate incomplete streaming assistant responses", () => {
    resetResponseIntegrityForTests()
    const text = "这是一段仍在流式生成中的正常响应，不应因为内容相同而删除。"
    const first = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text } as Part] },
    })
    const second = state({
      message: { ses_1: [{ id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2 } } as never] },
      part: { msg_2: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text } as Part] },
    })

    expect(applyDirectoryEvent(first, { type: "message.part.updated", properties: { sessionID: "ses_1", part: first.part.msg_1[0] } } as Event)).toBe(true)
    expect(applyDirectoryEvent(second, { type: "message.part.updated", properties: { sessionID: "ses_1", part: second.part.msg_2[0] } } as Event)).toBe(true)
    expect(second.message.ses_1).toHaveLength(1)
  })

  test("resets duplicate-response memory when a session is deleted", () => {
    resetResponseIntegrityForTests()
    const text = "这是一段足够长的正常响应，用于验证 session 删除后的状态重置。"
    const first = state({
      session: [buildSession("session", { created: 1, updated: 1 })],
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } } as never] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text } as Part] },
    })
    applyDirectoryEvent(first, { type: "message.part.updated", properties: { sessionID: "ses_1", part: first.part.msg_1[0] } } as Event)
    applyDirectoryEvent(first, { type: "session.deleted", properties: { sessionID: "ses_1" } } as Event)

    const next = state({
      message: { ses_1: [{ id: "msg_2", sessionID: "ses_1", role: "assistant", finish: "stop", time: { created: 3, completed: 4 } } as never] },
      part: { msg_2: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text } as Part] },
    })
    expect(applyDirectoryEvent(next, { type: "message.part.updated", properties: { sessionID: "ses_1", part: next.part.msg_2[0] } } as Event)).toBe(true)
    expect(next.message.ses_1).toHaveLength(1)
  })

  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("skips stale session.updated events so a newer title survives", () => {
    const draft = state({ session: [buildSession("New Title", { created: 1, updated: 20 })] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: buildSession("Old Title", { created: 1, updated: 10 }),
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session[0]?.title).toBe("New Title")
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })
})
