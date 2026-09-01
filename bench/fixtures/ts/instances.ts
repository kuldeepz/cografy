import { UserService, ProductService } from "./services";

export function pickUser(): string {
  const u = new UserService();
  return u.getName();
}

export function pickProduct(): string {
  const p = new ProductService();
  return p.getName();
}
