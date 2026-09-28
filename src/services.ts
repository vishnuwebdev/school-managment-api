import type { Deps } from './container.js';
import { AuthorizationService } from './modules/access/authorization.service.js';
import { RoleService } from './modules/access/roles.service.js';
import { EntitlementService } from './modules/entitlements/entitlements.service.js';
import { AuthService } from './modules/identity/auth.service.js';
import { TokenService } from './modules/identity/tokens.js';
import { MemberService } from './modules/members/members.service.js';
import { TenantService } from './modules/tenants/tenants.service.js';

export function buildServices(deps: Deps) {
  const tokens = new TokenService(deps.env);
  const authz = new AuthorizationService(deps);
  const entitlements = new EntitlementService(deps);
  const roles = new RoleService(deps, authz);
  const members = new MemberService(deps, authz, roles);
  const auth = new AuthService(deps, tokens, authz);
  const tenants = new TenantService(deps, entitlements, authz);
  return { tokens, authz, entitlements, roles, members, auth, tenants };
}

export type Services = ReturnType<typeof buildServices>;
