export class UserService {
  getName(): string {
    return "user";
  }
  describe(): string {
    return this.getName() + " account";
  }
}

export class ProductService {
  getName(): string {
    return "product";
  }
  label(): string {
    return this.getName() + " item";
  }
}
