# 错误处理

VextJS 会统一捕获 route、middleware 和 service 中抛出的异常，并转换成 HTTP 响应。主动返回业务错误时优先使用 `app.throw(...)`；字段级校验失败使用 `VextValidationError`；未预期异常才直接 `throw new Error(...)`。

## `app.throw`

`app.throw` 适合“我要主动返回明确 HTTP 错误”的场景，例如 401、404、409、502，或需要业务码、i18n 参数、三方错误详情的响应。

```ts
// 基本错误
app.throw(404, "user.not_found");

// 业务错误码
app.throw(409, "email.taken", "EMAIL_TAKEN");

// i18n 插值参数 + 业务错误码
app.throw(400, "balance.insufficient", { balance: 50 }, 20001);

// 第四参数为对象或数组时，作为 details 输出
app.throw(
  502,
  "payment.failed",
  { orderId },
  {
    provider: "stripe",
    providerCode: "card_declined",
  },
);

// 同时需要 code + details 时，使用对象式入口
app.throw({
  status: 502,
  message: "payment.failed",
  code: "PAYMENT_FAILED",
  details: { provider: "stripe", providerCode: "card_declined" },
});
```

`app.throw()` 返回类型是 `never`，调用后会中断当前处理流程，不需要额外 `return`。

## `details`

`details` 用来显式返回业务详情，常见于三方接口或下游服务错误：

- 上游业务码、原始 message、trace id
- 可展示给调用方的失败原因
- 业务方自行裁剪后的三方响应片段

框架会在写出响应前做 JSON-safe 清洗：循环引用会变成 `"[Circular]"`，`Date` 输出 ISO 字符串，`Error` 只输出 `name/message`，函数和 `undefined` 不会进入响应。

未知普通 `Error` 不会自动暴露 details。只有通过 `HttpError` 或 `app.throw` 显式传入的 details 才会返回给调用方。

## 响应格式

```json
{
  "code": "PAYMENT_FAILED",
  "message": "支付失败",
  "details": {
    "provider": "stripe",
    "providerCode": "card_declined"
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

`code` 优先使用显式业务码；未传业务码时，通常回退为 HTTP status。

## 与普通 Error 的区别

```ts
// 结构化业务错误：返回指定 status/message/code/details
app.throw(404, "user.not_found");

// 未预期运行时错误：进入 500 路径
throw new Error("Database connection lost");
```

生产环境建议保持 `response.hideInternalErrors = true`，避免未知 500 错误暴露内部栈信息。`app.throw` 和 `VextValidationError` 这类结构化错误不受该配置影响，会按自身状态码和响应体输出。

## 校验错误

路由 `validate` 失败时，非法路径参数返回 HTTP `400`，query、header、cookie 与 body 失败返回 HTTP `422`，两者都包含字段级错误详情。自定义字段级错误可以抛出 `VextValidationError`：

```ts
import { VextValidationError } from "vextjs";

throw new VextValidationError([{ field: "email", message: "Invalid email" }]);
```

## 更多参考

- [`app.throw` API](/api/app#appthrowstatus-message-paramsorcode-codeordetails)
- [中间件中的错误处理](/guide/middleware#错误处理中间件)
- [路由中的错误处理](/guide/routing#错误处理)
- [响应配置](/guide/configuration#响应配置-response)
