/**
 * 扫码登录的状态类型。
 *
 * 放在 `shared/` 而不是 `core/`：`shared/types/messages.ts` 要用它，
 * 而 shared 是最底层，不能反向依赖 core。
 */

export type QrLoginStatus =
  | { kind: 'pending' }
  | { kind: 'scanned' }
  | { kind: 'expired' }
  /** 登录成功。crossDomainUrl 不含凭据本身，可安全传给 UI */
  | { kind: 'success'; crossDomainUrl: string }
  | { kind: 'error'; code: number; message: string };
