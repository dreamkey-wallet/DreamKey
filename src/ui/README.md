# React Native UI

The `src/ui` package contains standalone React Native CLI screens and primitives for the wallet shell. It is intentionally independent of MetaMask source, assets, branding, navigation libraries, and hosted services.

## Screens

- `WalletHomeScreen`: account header, network selector, balance, send/receive/browser actions, assets and activity.
- `AccountsScreen` and `NetworksScreen`: account/network selection and creation/add actions.
- `AssetsScreen`: native and ERC-20 balances.
- `SendScreen`: recipient/amount validation and transaction submit callback.
- `SignRequestScreen`: explicit signing or transaction confirmation; accepts a `signature` preview from `getSignaturePreview(method, params)` to render decoded text, binary data or EIP-712 domain/message/type sections. `canApprove={false}` disables confirmation when a request cannot be parsed. Confirmation paints a spinner and progress text before calling `onApprove`, guards repeated presses, and retains feedback while an asynchronous callback is pending.
- `PermissionPrompt`: EIP-2255-style account access approval.
- `TransactionDetailScreen`: transaction status and explorer action.
- `DappBrowserScreen`: wraps the existing secure `DappBrowser` WebView and EIP-1193 bridge.

The routed application uses `wallet/WalletRouteScreens.tsx` for the home and asset routes, `screens/WalletManagementScreen.tsx` for wallet management, `NetworkRouteScreen.tsx` for networks, `TransferScreens.tsx` for sending and token management, and the separate receive, asset detail, DApp, settings, about and invite screens. Most files in `screens/` re-export the standalone components in `screens.tsx`; editing those standalone home examples does not change the routed home page. Authentication and password routes currently remain in `App.tsx`.

Standalone components receive data and side effects through props. Route adapters connect them to wallet context and navigation; balance, price and history hooks handle their own asynchronous data. Native camera, QR code, SVG and clipboard modules are also used.

## Layout and interaction

- Keep the existing DreamKey logo and dark navy/purple palette. The home wallet name has no avatar.
- Use `DreamKeyLogo` for screen branding and `DreamKeyLogoMark` inside SVG exports. The shared vector artwork also works in OTA bundles without loading a separate bitmap. Keep dynamically resolved Android DApp/navigation drawables in `res/raw/dreamkey_react_assets_keep.xml` when adding new asset groups.
- Give icon actions at least a 44 dp touch target. Let long labels wrap and constrain row copy so names cannot push actions off screen.
- Keep forms and modal contents scrollable when the keyboard or larger text reduces the available height. Wait for iOS modal dismissal before opening the next modal.
- Show loading, empty and recoverable failure states near their relevant action. Preserve confirmation and identity checks for sensitive operations.
- Show complete selectable addresses in transaction details and approvals. Display the selected wallet name on home, send, receive and asset detail routes.
- Popular DApps retain two rows of five, with horizontal paging. Curated shortcuts use public project websites and bundled logos.

## Verification

`npm run typecheck`, `npm run verify:security`, `npm run verify:updates` and `npm run verify:rpc` cover shared flows. Individual creation, import-feedback and invitation scripts cover their asynchronous interactions with public fixtures. These scripts do not verify native layout pixels, physical camera capture or system share sheets; those require device checks in both languages with a smaller screen and larger text.

Example:

```tsx
<WalletHomeScreen
  account={wallet.getAccount(0)}
  network={wallet.getNetwork(selectedNetworkId)}
  nativeBalance={balance}
  assets={erc20Assets}
  onSend={() => navigation.navigate('Send')}
/>
```
