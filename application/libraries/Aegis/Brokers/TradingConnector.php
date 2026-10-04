<?php
namespace Aegis\Brokers;

/**
 * Order-capable broker boundary (Phase 4+). A connector that can actually
 * route orders implements this IN ADDITION to BrokerConnector and must only
 * report capabilities()['orderSubmission'] === true when every gate
 * (configuration, bridge health, explicit trading opt-in, demo-only default)
 * is satisfied. Read-only connectors never implement it.
 *
 * All methods return NORMALIZED contracts (BrokerDataNormalizer) and never
 * leak credentials, URLs with query strings, or raw provider payloads.
 */
interface TradingConnector extends BrokerConnector
{
    /** Normalized account snapshot (BrokerDataNormalizer::account). */
    public function account(): array;

    /** Normalized quote (BrokerDataNormalizer::quote). */
    public function quote(string $symbol): array;

    /** @return array<int, array<string, mixed>> normalized open positions */
    public function positions(): array;

    /** @return array<int, array<string, mixed>> normalized pending orders */
    public function pendingOrders(): array;

    /** @return array<int, array<string, mixed>> normalized closed trades */
    public function history(int $limit = 100): array;

    /**
     * Place an order. $order = {symbol, side BUY|SELL, type MARKET|LIMIT,
     * volume, price?, stopLoss, takeProfit?}. Returns the broker result
     * contract {ticket, price, placedAt, raw?} or throws.
     */
    public function placeOrder(array $order): array;

    /** Modify a pending order / position SL-TP ({stopLoss?, takeProfit?, price?}). */
    public function modifyOrder(int $ticket, array $changes): array;

    /** Cancel a pending order. */
    public function cancelOrder(int $ticket): array;

    /** Close an open position. */
    public function closePosition(int $ticket): array;
}
