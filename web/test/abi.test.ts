import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toEventSignature, toFunctionSignature, type Abi, type AbiEvent, type AbiFunction } from "viem";
import { expect, test } from "vitest";
import { escrowAbi, routerAbi, usdcAbi } from "../src/abi.ts";

const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));

function artifact(name: string): Abi {
  return JSON.parse(readFileSync(`${OUT}${name}.sol/${name}.json`, "utf8")).abi;
}

function signatures(abi: Abi): string[] {
  return abi.flatMap((item) => {
    if (item.type === "function") return [`${toFunctionSignature(item as AbiFunction)} ${item.stateMutability}`];
    if (item.type === "event") return [toEventSignature(item as AbiEvent)];
    if (item.type === "error") return [`error ${item.name}(${item.inputs.map((i) => i.type).join(",")})`];
    return [];
  });
}

test.each([
  ["BonaFideEscrow", escrowAbi],
  ["CharityRouter", routerAbi],
  ["MockUSDC", usdcAbi],
])("every function, event and error the pages use is in %s's ABI, with the same types", (name, abi) => {
  const contract = signatures(artifact(name));

  for (const signature of signatures(abi)) expect(contract).toContain(signature);
});

test("indexed event arguments match, so the pages' log filters find the escrow's events", () => {
  const contract = artifact("BonaFideEscrow").filter((item) => item.type === "event") as AbiEvent[];

  for (const event of escrowAbi.filter((item) => item.type === "event") as AbiEvent[]) {
    const onChain = contract.find((e) => e.name === event.name)!;
    expect(event.inputs.map((i) => [i.name, i.indexed ?? false])).toEqual(
      onChain.inputs.map((i) => [i.name, i.indexed ?? false]),
    );
  }
});
