import { UserService } from "./services";

const svc = new UserService();

export function getWhoami(): string {
  return svc.describe();
}
