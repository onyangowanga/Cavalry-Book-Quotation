import java.io.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Scanner;

/**
 * CatalogueService.java - Manages persistence (reading/writing) of Book objects
 * to and from a flat CSV file.
 */
public class CatalogueService {
    
    // --- New Field ---
    private final String filePath;
    
    // --- Fixed Constructor ---
    public CatalogueService(String filePath) {
        this.filePath = filePath;
        // Ensure the file exists on startup
        File file = new File(filePath);
        if (!file.exists()) {
            try {
                // Creates file and writes header
                FileWriter writer = new FileWriter(filePath, true);
                writer.write("Name,Pages,ColorPages,SizeCode,UnitCost\n");
                writer.close();
            } catch (IOException e) {
                // Cannot exit here, just print error
                System.err.println("Error creating catalogue file: " + e.getMessage());
            }
        }
    }

    /**
     * Loads all book records from the CSV file.
     * @return A List of Book objects.
     * @throws IOException if file cannot be read.
     * @throws NumberFormatException if data in the file is corrupt.
     */
    public List<Book> loadCatalogue() throws IOException, NumberFormatException {
        List<Book> catalogue = new ArrayList<>();
        File file = new File(this.filePath);
        
        if (!file.exists()) {
            return catalogue;
        }

        try (Scanner scanner = new Scanner(file)) {
            if (scanner.hasNextLine()) {
                scanner.nextLine(); // Skip header row
            }
            
            int lineNumber = 1; // Start count after header
            while (scanner.hasNextLine()) {
                String line = scanner.nextLine();
                lineNumber++;

                String[] parts = line.split(",");
                if (parts.length != 5) {
                    System.err.println("Skipping malformed line in CSV (line " + lineNumber + "): " + line);
                    continue; 
                }

                try {
                    String name = parts[0].trim();
                    int totalPages = Integer.parseInt(parts[1].trim());
                    int colorPages = Integer.parseInt(parts[2].trim());
                    String sizeCode = parts[3].trim();
                    double unitCost = Double.parseDouble(parts[4].trim());
                    
                    catalogue.add(new Book(name, totalPages, colorPages, sizeCode, unitCost));
                } catch (NumberFormatException e) {
                    // Propagate the error clearly for the main UI
                    throw new NumberFormatException("Error parsing numeric data on line " + lineNumber + " of CSV: " + e.getMessage());
                }
            }
        }
        return catalogue;
    }

    /**
     * Appends a single Book object to the CSV file.
     * @param book The Book object to save.
     * @throws IOException if file cannot be written.
     */
    public void appendBook(Book book) throws IOException {
        try (FileWriter writer = new FileWriter(this.filePath, true)) {
            // Format: Name,Pages,ColorPages,SizeCode,UnitCost
            String line = String.format("%s,%d,%d,%s,%.2f\n", 
                book.getBookName().replace(",", ""), 
                book.getTotalPages(), 
                book.getColorPages(), 
                book.getPageSize(), 
                book.getCostPerBook());
            writer.write(line);
        }
    }
    
    /**
     * Rewrites the entire catalogue file with the current list of books.
     * Used for deletions/updates.
     * @param catalogue The list of all books to save.
     * @throws IOException if file cannot be written.
     */
    public void rewriteCatalogue(List<Book> catalogue) throws IOException {
        // Use false for append to overwrite the file
        try (FileWriter writer = new FileWriter(this.filePath, false)) { 
            // Write header first
            writer.write("Name,Pages,ColorPages,SizeCode,UnitCost\n");
            
            // Write all books
            for (Book book : catalogue) {
                String line = String.format("%s,%d,%d,%s,%.2f\n", 
                    book.getBookName().replace(",", ""), 
                    book.getTotalPages(), 
                    book.getColorPages(), 
                    book.getPageSize(), 
                    book.getCostPerBook());
                writer.write(line);
            }
        }
    }
}