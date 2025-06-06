import type * as nt from '@broxus/ever-wallet-wasm'
import cloneDeep from 'lodash.clonedeep'
import log from 'loglevel'

import { getNftImage, getNftPreview, NekotonRpcError, RpcErrorCode } from '@app/shared'
import type {
    BaseNftJson,
    GetNftsParams,
    GetNftsResult,
    Nekoton,
    NetworkGroup,
    Nft,
    NftCollection,
    NftTransfer,
    NftTransferToPrepare,
    RpcEvent,
} from '@app/models'
import { INftTransferAbi } from '@app/abi'

import { Deserializers, Storage } from '../utils/Storage'
import { BaseConfig, BaseController, BaseState } from './BaseController'
import { ConnectionController } from './ConnectionController'
import { AccountController, ITransactionsListener } from './AccountController/AccountController'

interface NftControllerConfig extends BaseConfig {
    nekoton: Nekoton;
    connectionController: ConnectionController;
    accountController: AccountController;
    storage: Storage<NftStorage>;
    sendEvent?: (event: RpcEvent) => void;
}

interface NftControllerState extends BaseState {
    accountNftCollections: Record<NetworkGroup, {
        [owner: string]: { [collection: string]: NftCollection }
    }>
    accountPendingNfts: Record<NetworkGroup, {
        [owner: string]: { [collection: string]: NftTransfer[] }
    }>;
    nftCollectionsVisibility: { [owner: string]: { [address: string]: boolean | undefined } };
}

const defaultState: NftControllerState = {
    accountNftCollections: {},
    accountPendingNfts: {},
    nftCollectionsVisibility: {},
}

export class NftController extends BaseController<NftControllerConfig, NftControllerState> {

    constructor(
        config: NftControllerConfig,
        state?: NftControllerState,
    ) {
        super(config, state || cloneDeep(defaultState))

        this.initialize()
        this._subscribeForTransactions()
    }

    public initialSync(): void {
        const { storage } = this.config
        const accountNftCollections = storage.snapshot.accountNftCollections ?? {}
        const nftCollectionsVisibility = storage.snapshot.nftCollectionsVisibility ?? {}
        const accountPendingNfts = storage.snapshot.accountPendingNfts ?? {}

        this.update({
            accountNftCollections,
            nftCollectionsVisibility,
            accountPendingNfts,
        })
    }

    public async clear() {
        await this.config.storage.remove([
            'accountNftCollections',
            'nftCollectionsVisibility',
            'accountPendingNfts',
        ])
    }

    public async updateNftCollectionVisibility(
        owner: string,
        params: Record<string, boolean>,
    ): Promise<void> {
        const { nftCollectionsVisibility } = this.state

        this.update({
            nftCollectionsVisibility: {
                ...nftCollectionsVisibility,
                [owner]: {
                    ...nftCollectionsVisibility[owner],
                    ...params,
                },
            },
        })

        await this._saveNftCollectionsVisibility()
    }

    public async scanNftCollections(owner: string, addresses: string[]): Promise<NftCollection[]> {
        return this.config.connectionController.use(async ({ data: { transport }}) => {
            const collections = await Promise.all(addresses.map(async (address) => {
                let collection: nt.NftCollection | undefined
                try {
                    collection = await transport.getNftCollection(address)
                    const list = await collection.getNfts(owner, 1) // getNftIndexContracts

                    if (list.accounts.length === 0) return null

                    return mapNftCollection(collection)
                }
                catch (e) {
                    log.error(e)
                    return null
                }
                finally {
                    collection?.free()
                }
            }))

            return collections.filter((collection) => !!collection) as NftCollection[]
        })
    }

    public async getNftCollections(addresses: string[]): Promise<NftCollection[]> {
        return this.config.connectionController.use(async ({ data: { transport }}) => Promise.all(
            addresses.map(async (address) => {
                let collection: nt.NftCollection | undefined
                try {
                    collection = await transport.getNftCollection(address)
                    return mapNftCollection(collection)
                }
                finally {
                    collection?.free()
                }
            }),
        ))
    }

    public async getNftsByCollection(params: GetNftsParams): Promise<GetNftsResult> {
        return this.config.connectionController.use(async ({ data: { transport }}) => {
            let collection: nt.NftCollection | undefined
            const nfts: nt.Nft[] = []
            try {
                collection = await transport.getNftCollection(params.collection)
                const list = await collection.getNfts(params.owner, params.limit, params.continuation)
                const result = await Promise.allSettled(
                    list.accounts.map((address) => transport.subscribeToNftByIndexAddress(address, noopHandler)),
                )

                for (const item of result) {
                    if (item.status === 'fulfilled') {
                        nfts.push(item.value)
                    }
                }

                return {
                    nfts: nfts.map<Nft>(mapNft),
                    continuation: list.continuation,
                }
            }
            finally {
                collection?.free()
                nfts?.forEach((nft) => nft.free())
            }
        })
    }

    public async getNfts(addresses: string[]): Promise<Nft[]> {
        return this.config.connectionController.use(async ({ data: { transport }}) => {
            const nfts: nt.Nft[] = []
            try {
                const result = await Promise.allSettled(
                    addresses.map((address) => transport.subscribeToNft(address, noopHandler)),
                )

                for (const item of result) {
                    if (item.status === 'fulfilled') {
                        nfts.push(item.value)
                    }
                }

                return nfts.map<Nft>(mapNft)
            }
            finally {
                nfts?.forEach((nft) => nft.free())
            }
        })
    }

    public async prepareNftTransfer(
        address: string,
        params: NftTransferToPrepare,
    ): Promise<nt.InternalMessage> {
        return this.config.connectionController.use(async ({ data: { transport }}) => {
            let nft: nt.Nft | undefined
            try {
                nft = await transport.subscribeToNft(address, noopHandler)
                const message = await nft.prepareTransfer(params.recipient, params.sendGasTo, params.callbacks)

                return {
                    ...message,
                    amount: '3000000000',
                }
            }
            finally {
                nft?.free()
            }
        })
    }

    public async updateAccountNftCollections(owner: string, collections: NftCollection[]): Promise<void> {
        const { group } = this.config.connectionController.state.selectedConnection
        const { accountNftCollections } = this.state

        this.update({
            accountNftCollections: {
                ...accountNftCollections,
                [group]: {
                    ...accountNftCollections[group],
                    [owner]: collections.reduce((result, collection) => {
                        result[collection.address] = collection
                        return result
                    }, {} as Record<string, NftCollection>),
                },
            },
        })

        await this._saveAccountNftCollections()
    }

    public async searchNftCollectionByAddress(owner:string, address: string): Promise<NftCollection> {
        return this.config.connectionController.use(async ({ data: { transport }}) => {
            let nft: nt.Nft | undefined,
                collection: nt.NftCollection | undefined

            try {
                try {
                    nft = await transport.subscribeToNft(address, noopHandler)
                }
                catch {}

                if (nft && nft.owner !== owner) {
                    throw new NekotonRpcError(RpcErrorCode.INVALID_REQUEST, 'Not nft owner')
                }

                collection = await transport.getNftCollection(nft?.collection ?? address)
                return mapNftCollection(collection)
            }
            finally {
                nft?.free()
                collection?.free()
            }
        })
    }

    public async removeAccountPendingNfts(owner: string, collection: string): Promise<NftTransfer[] | undefined> {
        const { group } = this.config.connectionController.state.selectedConnection
        const updatedValue: NftControllerState['accountPendingNfts'] = {
            ...this.state.accountPendingNfts,
            [group]: {
                ...this.state.accountPendingNfts[group],
                [owner]: {
                    ...this.state.accountPendingNfts[group]?.[owner],
                },
            },
        }
        const removed = updatedValue[group]?.[owner]?.[collection]

        if (removed) {
            delete updatedValue[group]?.[owner]?.[collection]

            this.update({
                accountPendingNfts: updatedValue,
            })

            await this._saveAccountPendingNfts()
        }

        return removed
    }

    private _updateNftTransfers(address: string, transactions: nt.TonWalletTransaction[]) {
        const { connectionController, sendEvent } = this.config
        const { group } = connectionController.state.selectedConnection
        const { accountPendingNfts } = this.state
        const pending = accountPendingNfts[group]?.[address] ?? {}
        const transferred: NftTransfer[] = []
        let update = false

        for (const transaction of transactions) {
            try {
                const decoded = this.config.nekoton.decodeTransaction(transaction, INftTransferABI, 'onNftTransfer')

                if (!decoded || !transaction.inMessage.src) continue

                const oldOwner = decoded.input.oldOwner as string
                const newOwner = decoded.input.newOwner as string
                const collection = decoded.input.collection as string
                const nft = transaction.inMessage.src

                if (newOwner === address) {
                    // nft in transfer
                    update = true

                    if (!pending[collection]) {
                        pending[collection] = []
                    }

                    pending[collection].push({
                        address: nft,
                        collection,
                        oldOwner,
                        newOwner,
                    })
                }
                else if (oldOwner === address) {
                    transferred.push({
                        address: nft,
                        collection,
                        oldOwner,
                        newOwner,
                    })
                }
            }
            catch {}
        }

        if (update) {
            this.update({
                accountPendingNfts: {
                    ...accountPendingNfts,
                    [group]: {
                        ...accountPendingNfts[group],
                        [address]: pending,
                    },
                },
            })

            this._saveAccountPendingNfts().catch(log.error)
        }

        if (transferred.length) {
            sendEvent?.({
                type: 'ntf-transfer',
                data: transferred,
            })
        }
    }

    private _subscribeForTransactions() {
        const listener: ITransactionsListener = {
            onEverTransactionsFound: (
                address: string,
                _walletDetails: nt.TonWalletDetails,
                transactions: nt.TonWalletTransaction[],
                info: nt.TransactionsBatchInfo,
            ) => {
                if (info.batchType === 'new') {
                    this._updateNftTransfers(address, transactions)
                }
            },
        }

        this.config.accountController.addTransactionsListener(listener)
    }

    private _saveAccountNftCollections(): Promise<void> {
        return this.config.storage.set({
            accountNftCollections: this.state.accountNftCollections,
        })
    }

    private _saveNftCollectionsVisibility(): Promise<void> {
        return this.config.storage.set({
            nftCollectionsVisibility: this.state.nftCollectionsVisibility,
        })
    }

    private _saveAccountPendingNfts(): Promise<void> {
        return this.config.storage.set({
            accountPendingNfts: this.state.accountPendingNfts,
        })
    }

}

function mapNftCollection(collection: nt.NftCollection): NftCollection {
    const json = JSON.parse(collection.json ?? '{}') as BaseNftJson

    return {
        address: collection.address,
        name: json.name ?? '',
        description: json.description ?? '',
        preview: getNftPreview(json),
    }
}

function mapNft(nft: nt.Nft): Nft {
    const json = JSON.parse(nft.json ?? '{}') as BaseNftJson
    return {
        address: nft.address,
        collection: nft.collection,
        owner: nft.owner,
        manager: nft.manager,
        name: json.name ?? '',
        description: json.description ?? '',
        preview: getNftPreview(json),
        img: getNftImage(json),
    }
}

const noopHandler: nt.NftSubscriptionHandler = {
    onManagerChanged() {},
    onMessageExpired() {},
    onMessageSent() {},
    onOwnerChanged() {},
}

const INftTransferABI = JSON.stringify(INftTransferAbi)

interface NftStorage {
    accountNftCollections: NftControllerState['accountNftCollections'];
    nftCollectionsVisibility: NftControllerState['nftCollectionsVisibility'];
    accountPendingNfts: NftControllerState['accountPendingNfts'];
}

Storage.register<NftStorage>({
    accountNftCollections: { deserialize: Deserializers.object },
    nftCollectionsVisibility: { deserialize: Deserializers.object },
    accountPendingNfts: { deserialize: Deserializers.object },
})
