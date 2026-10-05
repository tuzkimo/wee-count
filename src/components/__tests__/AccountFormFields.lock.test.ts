import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AccountFormFields from "@/components/AccountFormFields.vue";

/**
 * 期初金额锁定的 UI 契约。
 *
 * 为什么要有 readonly 之外的第二道闸：`readonly` 只是浏览器层的约束，
 * 程序化赋 value 再派发 input 事件照样能走进 @input 处理器。锁定态的
 * 处理器必须自己吞掉事件，否则 AccountEdit 会拿着被改过的期初金额去提交。
 */
function mountFields(opts: { locked?: boolean; accountType?: "bank" | "credit_card" } = {}) {
  const accountType = opts.accountType ?? "bank";
  return mount(AccountFormFields, {
    props: {
      name: "招商银行",
      categoryTab: accountType === "bank" ? ("asset" as const) : ("liability" as const),
      accountType,
      initialBalance: "1000",
      creditLimit: "",
      repaymentDay: "",
      color: "#3b82f6",
      initialBalanceLocked: opts.locked ?? false,
    },
  });
}

/** 表单里第一个 number 输入框就是期初金额（后面才是额度、还款日）。 */
function initialInput(wrapper: ReturnType<typeof mountFields>) {
  const input = wrapper.find('input[type="number"]');
  if (!input.exists()) throw new Error("未找到期初金额输入框");
  return input;
}

describe("AccountFormFields 期初金额锁定", () => {
  it("锁定态：输入框只读、原值可见、给出不可修改的原因", () => {
    const w = mountFields({ locked: true });
    const input = initialInput(w);
    expect(input.attributes("readonly")).toBeDefined();
    expect((input.element as HTMLInputElement).value).toBe("1000");
    expect(w.text()).toContain("不可再修改");
  });

  it("锁定态：程序化改值也不 emit，避免被污染的值流进保存 payload", async () => {
    const w = mountFields({ locked: true });
    await initialInput(w).setValue("999999");
    expect(w.emitted("update:initialBalance")).toBeUndefined();
  });

  it("未锁定：可编辑并正常 emit", async () => {
    const w = mountFields({ locked: false });
    const input = initialInput(w);
    expect(input.attributes("readonly")).toBeUndefined();
    expect(w.text()).not.toContain("不可再修改");
    await input.setValue("2000");
    expect(w.emitted("update:initialBalance")).toEqual([["2000"]]);
  });

  it("负债账户锁定：按「初始欠款」的口径提示", () => {
    const w = mountFields({ locked: true, accountType: "credit_card" });
    expect(w.text()).toContain("初始欠款");
    expect(w.text()).toContain("不可再修改");
  });
});
