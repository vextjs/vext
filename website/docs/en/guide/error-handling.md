# Error handling

VextJS will uniformly capture exceptions thrown in routes, middleware, and services and convert them into HTTP responses. `app.throw(...)` is preferred when actively returning business errors; `VextValidationError` is used when field-level verification fails; `throw new Error(...)` is used only when exceptions are not expected.

## `app.throw`

`app.throw` is suitable for scenarios where "I want to actively return clear HTTP errors", such as 401, 404, 409, 502, or responses that require business codes, i18n parameters, and third-party error details.

```ts
//Basic error
app.throw(404, "user.not_found");

//Business error code
app.throw(409, "email.taken", "EMAIL_TAKEN");

// i18n interpolation parameter + business error code
app.throw(400, "balance.insufficient", { balance: 50 }, 20001);

// When the fourth parameter is an object or array, it is output as details
app.throw(
  502,
  "payment.failed",
  { orderId },
  {
    provider: "stripe",
    providerCode: "card_declined",
  },
);

// When code + details are required at the same time, use the object entry
app.throw({
  status: 502,
  message: "payment.failed",
  code: "PAYMENT_FAILED",
  details: { provider: "stripe", providerCode: "card_declined" },
});
```

The return type of `app.throw()` is `never`. After calling, the current processing flow will be interrupted, no additional `return` is required.

## `details`

`details` is used to explicitly return business details, which is common in third-party interface or downstream service errors:

- Upstream business code, original message, trace id
- Reason for failure that can be shown to the caller
- Three-party response fragments tailored by the business party themselves

The framework will do JSON-safe cleaning before writing the response: circular references will become `"[Circular]"`, `Date` will output an ISO string, `Error` will only output `name/message`, and functions and `undefined` will not enter the response.

Unknown plain `Error` does not automatically expose details. Only details passed explicitly via `HttpError` or `app.throw` will be returned to the caller.

## Response format

```json
{
  "code": "PAYMENT_FAILED",
  "message": "Payment failed",
  "details": {
    "provider": "stripe",
    "providerCode": "card_declined"
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

`code` preferentially uses explicit business code; when no business code is passed, it usually falls back to HTTP status.

## Differences from ordinary Error

```ts
//Structured business error: return specified status/message/code/details
app.throw(404, "user.not_found");

// Unexpected runtime error: Entering 500 path
throw new Error("Database connection lost");
```

In production environments, it is recommended to keep `response.hideInternalErrors = true` to avoid unknown 500 errors exposing internal stack information. Structural errors such as `app.throw` and `VextValidationError` are not affected by this configuration and will be output according to their own status codes and response bodies.

## Verification error

When route `validate` fails, invalid path parameters return HTTP `400`; query, header, cookie, and body failures return HTTP `422`. Both include field-level error details. Custom field-level errors can throw `VextValidationError`:

```ts
import { VextValidationError } from "vextjs";

throw new VextValidationError([{ field: "email", message: "Invalid email" }]);
```

## More references

- [`app.throw` API](/api/app#appthrowstatus-message-paramsorcode-codeordetails)
- [Error handling in middleware](/guide/middleware#Error handling)
- [Error handling in routing](/guide/routing#Error handling)
- [Response Configuration](/guide/configuration#Response Configuration)
