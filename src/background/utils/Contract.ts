import type {
    AbiFunctionInputs,
    AbiFunctionName,
    AbiParam,
    DecodedAbiFunctionOutputs,
} from 'everscale-inpage-provider'
import { parseTokensObject, serializeTokensObject } from 'everscale-inpage-provider/dist/models'
import type * as nt from '@broxus/ever-wallet-wasm'

import type { Nekoton } from '@app/models'
import type { ConnectionController } from '@app/background/controllers/ConnectionController'

export type ContractFunction = { name: string; inputs?: AbiParam[]; outputs?: AbiParam[] };

export class ContractFactory {

    constructor(
        private nekoton: Nekoton,
        private clock: nt.ClockWithOffset,
        private connectionController: ConnectionController,
    ) { }

    public create<Abi>(abi: Abi, address: string): Contract<Abi> {
        return new Contract<Abi>({
            address,
            abi,
            clock: this.clock,
            nekoton: this.nekoton,
            connectionController: this.connectionController,
        })
    }

}

interface ContractConfig<Abi> {
    nekoton: Nekoton;
    connectionController: ConnectionController;
    clock: nt.ClockWithOffset;
    abi: Abi;
    address: string;
}

export class Contract<Abi> {

    private readonly _config: ContractConfig<Abi>

    private readonly _functions: Record<string, { inputs: AbiParam[], outputs: AbiParam[] }>

    private readonly _abi: string

    constructor(config: ContractConfig<Abi>) {
        this._config = config
        this._abi = JSON.stringify(config.abi)
        this._functions = ((config.abi as any).functions as ContractFunction[]).reduce((functions, item) => {
            functions[item.name] = { inputs: item.inputs || [], outputs: item.outputs || [] }
            return functions
        }, {} as Record<string, { inputs: AbiParam[], outputs: AbiParam[] }>)
    }

    public async call<K extends AbiFunctionName<Abi>>(
        method: K,
        inputs: AbiFunctionInputs<Abi, K>,
        contractState?: nt.FullContractState,
    ): Promise<DecodedAbiFunctionOutputs<Abi, K>> {
        const _contractState = contractState ?? await this._config.connectionController.use(
            async ({ data: { transport }}) => transport.getFullContractState(this._config.address),
        )

        if (!_contractState) throw new Error('Account not found')

        const { output, code } = this._config.nekoton.runLocal(
            this._config.clock,
            _contractState.boc,
            this._abi,
            method,
            serializeTokensObject(inputs),
            false,
        )

        if (!output || code !== 0) {
            throw new Error(`TvmException code: ${code}`)
        }

        return parseTokensObject(this._functions[method].outputs, output) as any
    }

}
