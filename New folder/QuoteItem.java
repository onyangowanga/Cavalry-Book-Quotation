/**
 * QuoteItem.java - Represents a single item in a client quote, 
 * holding the Book object and the desired quantity.
 */
public class QuoteItem {
    private final Book book;
    private int quantity; // Not final as quantity can be changed in the QuoteBuilderDialog

    public QuoteItem(Book book, int quantity) {
        if (book == null) {
            throw new IllegalArgumentException("Book cannot be null.");
        }
        if (quantity <= 0) {
            throw new IllegalArgumentException("Quantity must be greater than zero.");
        }
        this.book = book;
        this.quantity = quantity;
    }

    // --- Getters ---

    public Book getBook() {
        return book;
    }

    public int getQuantity() {
        return quantity;
    }

    /**
     * Calculates the total cost for this item (Unit Cost * Quantity).
     */
    public double getLineTotal() {
        // Ensure rounding to two decimal places
        double total = book.getCostPerBook() * quantity;
        return Math.round(total * 100.0) / 100.0;
    }

    // --- Setter ---

    public void setQuantity(int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("Quantity must be greater than zero.");
        }
        this.quantity = quantity;
    }
}