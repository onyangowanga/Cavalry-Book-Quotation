/**
 * Book.java - Simple data structure (model) for a single book entry.
 * Implements data validation for its properties.
 */
public class Book {
    private final String bookName;
    private final int totalPages;
    private final int colorPages;
    private final String pageSize; // E.g., "1", "2", or "3"
    private final double costPerBook; // Calculated unit cost

    public Book(String bookName, int totalPages, int colorPages, String pageSize, double costPerBook) {
        // Simple validation, though most should be handled by calling code
        if (bookName == null || bookName.trim().isEmpty()) {
            throw new IllegalArgumentException("Book name cannot be empty.");
        }
        if (totalPages <= 0) {
            throw new IllegalArgumentException("Total pages must be positive.");
        }
        if (colorPages < 0 || colorPages > totalPages) {
            throw new IllegalArgumentException("Color pages must be between 0 and total pages.");
        }
        if (pageSize == null || pageSize.isEmpty()) {
             throw new IllegalArgumentException("Page size code cannot be empty.");
        }
        if (costPerBook <= 0.0) {
            // Allow 0.0 only if necessary, but generally cost should be positive
            throw new IllegalArgumentException("Cost per book must be positive.");
        }
        
        this.bookName = bookName;
        this.totalPages = totalPages;
        this.colorPages = colorPages;
        this.pageSize = pageSize;
        this.costPerBook = costPerBook;
    }

    // --- Getters ---

    public String getBookName() {
        return bookName;
    }

    public int getTotalPages() {
        return totalPages;
    }

    public int getColorPages() {
        return colorPages;
    }

    public String getPageSize() {
        return pageSize;
    }

    public double getCostPerBook() {
        return costPerBook;
    }

    /**
     * Converts the book data into an array of Objects, suitable for use with JTable.
     * @return An array of Objects {Name, Pages, Color, Size, UnitCost}
     */
    public Object[] toArray() {
        // Format cost for display
        String formattedCost = String.format("%,.2f", costPerBook); 
        return new Object[]{bookName, totalPages, colorPages, "Code " + pageSize, formattedCost};
    }
}