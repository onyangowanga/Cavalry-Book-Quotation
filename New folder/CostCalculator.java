/**
 * CostCalculator.java - Provides static methods to calculate the unit cost 
 * of a book based on page counts and size code.
 */
public class CostCalculator {

    // Base costs for black & white pages (per page)
    private static final double BW_COST_RATE_1 = 1.2; 
    private static final double BW_COST_RATE_2 = 2.4;
    private static final double BW_COST_RATE_3 = 0.6; 
    
    // Base costs for color pages (per page)
    private static final double COLOR_COST_RATE_1 = 5.0; 
    private static final double COLOR_COST_RATE_2 = 8.0; 
    private static final double COLOR_COST_RATE_3 = 2.5; 

    // Fixed binding/setup cost per book, regardless of pages
    private static final double BINDING_COST = 180.0; 

    // Fixed COVER/setup cost per book, regardless of pages
    private static final double COVER_COST = 50.0; 

    /**
     * Calculates the estimated unit cost per book.
     * @param totalPages The total number of pages.
     * @param colorPages The number of color pages.
     * @param pageSizeCode A string code defining the print size (e.g., "1 (A5/B5)").
     * @return The calculated cost in Kshs.
     */
    public static double calculateCost(int totalPages, int colorPages, String pageSizeCode) {
        if (totalPages <= 0 || colorPages < 0 || colorPages > totalPages) {
            throw new IllegalArgumentException("Invalid page counts for cost calculation.");
        }

        // Extract the numeric code from the size string (e.g., "1" from "1 (A5/B5)")
        String code = pageSizeCode.substring(0, 1);

        double bwCostRate;
        double colorCostRate;

        // Determine rates based on size code
        switch (code) {
            case "1": // A5/B5
                bwCostRate = BW_COST_RATE_1;
                colorCostRate = COLOR_COST_RATE_1;
                break;
            case "2": // A4 Standard
                bwCostRate = BW_COST_RATE_2;
                colorCostRate = COLOR_COST_RATE_2;
                break;
            case "3": // A6/Large 
                bwCostRate = BW_COST_RATE_3;
                colorCostRate = COLOR_COST_RATE_3;
                break;
            default:
                throw new IllegalArgumentException("Invalid page size code: " + pageSizeCode);
        }

        int bwPages = totalPages - colorPages;

        double totalCost = 
            (bwPages * bwCostRate) + 
            (colorPages * colorCostRate) + 
            BINDING_COST + COVER_COST; 

        // Round the total cost to two decimal places
        totalCost = Math.round(totalCost * 100.0) / 100.0;

        return totalCost;
    }
}