import javax.swing.*;
import javax.swing.table.DefaultTableModel;
import javax.swing.event.TableModelEvent;
import javax.swing.event.TableModelListener;
import java.awt.*;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Printing Catalogue Manager (Swing GUI Application)
 * * This application reads a CSV file containing book catalogue data, displays it
 * in a JTable, and provides an integrated Quote Builder Dialog (Shopping Cart) 
 * for real-time calculation and quote generation.
 * * QuoteBuilderDialog enforces a minimum invoice cost of Kshs. 400.
 * * UPDATED: QuoteBuilderDialog now includes Client Name and Phone fields for 
 * sending quotes, and the WhatsApp message formatting is enhanced with bold text.
 */
public class CatalogueManager extends JFrame {

    // --- Constants ---
    private static final String CSV_FILE_PATH = "books_catalogue.csv";
    // This is the SENDER's number (used as fallback for catalogue or if client field is empty)
    private static final String DEFAULT_SENDER_PHONE = "+254748217344"; 
    private static final double MINIMUM_COST = 400.0;
    private static final String TILL_NUMBER = "5675635";
    
    // Made instance variables public (default access) for QuoteBuilderDialog to access
    List<Book> catalogue = new ArrayList<>();
    JTable catalogueTable; // Used by QuoteBuilderDialog (now only for fetching all books)
    DefaultTableModel tableModel;
    
    // UI components for new book entry
    private JTextField pdfPathField;
    private JTextField bookNameField;
    private JTextField totalPagesField; 
    private JTextField colorPagesField; 
    private JComboBox<String> pageSizeComboBox;
    
    // REGEX for simple CSV parsing
    private static final Pattern CSV_PATTERN = Pattern.compile(
        "\"?([^\"]+?)\"?\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([\\w\\d]+)\\s*,\\s*([\\d.]+)"
    );

    // --- Book Data Model (Internal Class) ---
    private static class Book {
        private final String bookName;
        private final int totalPages;
        private final int colorPages;
        private final String pageSize;
        private final double costPerBook;

        public Book(String bookName, int totalPages, int colorPages, String pageSize, double costPerBook) {
            this.bookName = bookName;
            this.totalPages = totalPages;
            this.colorPages = colorPages;
            this.pageSize = pageSize;
            this.costPerBook = costPerBook;
        }

        // Getters
        public String getBookName() { return bookName; }
        public double getCostPerBook() { return costPerBook; }
        
        // Method to get data for JTable display
        public Object[] toArray() {
            return new Object[] {
                bookName,
                totalPages,
                colorPages,
                pageSize,
                String.format("Kshs. %,.2f", costPerBook)
            };
        }
        
        // Method to get data for writing to CSV
        public String toCSVString() {
            String sanitizedName = bookName.contains(",") ? "\"" + bookName + "\"" : bookName;
            return String.format("%s,%d,%d,%s,%.2f\n", 
                sanitizedName, totalPages, colorPages, pageSize, costPerBook);
        }
    }
    
    // --- Quote Item Data Model (Internal Class for the Shopping Cart) ---
    private static class QuoteItem {
        private final Book book;
        private int quantity;

        public QuoteItem(Book book, int quantity) {
            this.book = book;
            this.quantity = quantity;
        }
        
        public Book getBook() { return book; }
        public int getQuantity() { return quantity; }
        public void setQuantity(int quantity) { this.quantity = quantity; }
        public double getLineTotal() { return book.getCostPerBook() * quantity; }
        
        // Data for the Cart Table
        public Object[] toArray() {
            return new Object[] {
                book.getBookName(),
                String.format("Kshs. %,.0f", book.getCostPerBook()),
                quantity,
                String.format("Kshs. %,.0f", getLineTotal())
            };
        }
    }

    // --- Constructor & UI Initialization ---

    public CatalogueManager() {
        setTitle("Java Swing Printing Catalogue");
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setSize(1200, 800); 
        setLocationRelativeTo(null); 
        
        getRootPane().setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15)); 

        // 1. Initialize Table Model
        String[] columnNames = {"Book Name", "Pages", "Color", "Size", "Unit Cost"};
        tableModel = new DefaultTableModel(columnNames, 0) {
            @Override
            public boolean isCellEditable(int row, int column) {
                return false;
            }
        };
        catalogueTable = new JTable(tableModel);
        catalogueTable.setFillsViewportHeight(true);
        catalogueTable.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION); 

        // 2. Set up Layout
        setLayout(new BorderLayout(10, 10)); 

        // 3. Add Table to center with ScrollPane
        add(new JScrollPane(catalogueTable), BorderLayout.CENTER);

        // 4. Create New Book Input Panel (Top)
        add(createNewBookPanel(), BorderLayout.NORTH);

        // 5. Create Control Panel (Bottom)
        add(createControlPanel(), BorderLayout.SOUTH);

        setVisible(true);
        loadAndSortCatalogue(); 
    }
    
    /**
     * Creates the main control panel containing load, catalogue send, quote, and delete buttons.
     */
    private JPanel createControlPanel() {
        JPanel controlPanel = new JPanel(new FlowLayout(FlowLayout.CENTER, 15, 10));
        
        JButton loadButton = new JButton("Refresh Catalogue");
        JButton deleteButton = new JButton("Delete Selected Book");
        JButton quoteBuilderButton = new JButton("Open Quote Builder (Shopping Cart)");
        
        // NEW BUTTON FOR FULL CATALOGUE
        JButton sendCatalogueButton = new JButton("Send Full Catalogue");
        
        // Button Styling 
        loadButton.setBackground(new Color(60, 140, 200));
        loadButton.setForeground(Color.WHITE);

        quoteBuilderButton.setBackground(new Color(40, 170, 70));
        quoteBuilderButton.setForeground(Color.WHITE);
        
        // Styling for the new button
        sendCatalogueButton.setBackground(new Color(100, 80, 200)); 
        sendCatalogueButton.setForeground(Color.WHITE);
        
        deleteButton.setBackground(new Color(220, 50, 50));
        deleteButton.setForeground(Color.WHITE);
        
        Font buttonFont = new Font("SansSerif", Font.BOLD, 14);
        loadButton.setFont(buttonFont);
        quoteBuilderButton.setFont(buttonFont);
        sendCatalogueButton.setFont(buttonFont); 
        deleteButton.setFont(buttonFont);
        
        loadButton.setFocusPainted(false);
        quoteBuilderButton.setFocusPainted(false);
        sendCatalogueButton.setFocusPainted(false);
        deleteButton.setFocusPainted(false);

        // Action Listeners
        loadButton.addActionListener(e -> loadAndSortCatalogue());
        deleteButton.addActionListener(e -> deleteSelectedBook());
        quoteBuilderButton.addActionListener(e -> openQuoteBuilder()); 
        sendCatalogueButton.addActionListener(e -> sendFullCatalogue());

        controlPanel.add(loadButton);
        controlPanel.add(deleteButton);
        controlPanel.add(sendCatalogueButton); 
        controlPanel.add(quoteBuilderButton);
        
        return controlPanel;
    }
    
    /**
     * Gathers selected books and opens the Quote Builder Dialog.
     */
    private void openQuoteBuilder() {
        int[] selectedRows = catalogueTable.getSelectedRows();
        
        if (selectedRows.length == 0) {
            JOptionPane.showMessageDialog(this, 
                "Please select one or more books from the catalogue table to start a quote.", 
                "Selection Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        List<QuoteItem> quoteItems = new ArrayList<>();
        // Convert selected Book objects to QuoteItem objects with default quantity of 1
        for (int index : selectedRows) {
            // Check index bounds for safety
            if (index >= 0 && index < catalogue.size()) {
                 Book selectedBook = catalogue.get(index);
                 quoteItems.add(new QuoteItem(selectedBook, 1)); 
            }
        }
        
        // Clear selection on the main table for better UX after opening the dialog
        catalogueTable.clearSelection();

        // Open the dialog with the pre-selected items
        QuoteBuilderDialog dialog = new QuoteBuilderDialog(this, quoteItems);
        dialog.setVisible(true);
    }
    
    /**
     * Prompts for client name, prepares ALL books as a list, and sends 
     * a general catalogue message (not a quote).
     */
    private void sendFullCatalogue() {
        if (catalogue.isEmpty()) {
            JOptionPane.showMessageDialog(this, 
                "The catalogue is currently empty. Please add books first.", 
                "Catalogue Empty", JOptionPane.WARNING_MESSAGE);
            return;
        }

        // 1. Get Client Name (only name is mandatory for this general message)
        String name = JOptionPane.showInputDialog(this, "Please enter the client's name:", "Client Name", JOptionPane.QUESTION_MESSAGE);
        if (name == null || name.trim().isEmpty()) {
            return; 
        }

        // 2. Convert all books to QuoteItems (quantity 1 is used only for list structure)
        List<QuoteItem> fullCatalogueItems = new ArrayList<>();
        for (Book book : catalogue) {
            fullCatalogueItems.add(new QuoteItem(book, 1));
        }
        
        // 3. Send the message using the dedicated method
        // Use DEFAULT_SENDER_PHONE as the target for general catalogue messages
        createAndSendFullCatalogueMessage(fullCatalogueItems, name, DEFAULT_SENDER_PHONE);
    }
    
    /**
     * Generates and sends a message listing the entire catalogue with unit prices.
     * This method does NOT include totals, discounts, or minimum cost enforcement.
     * @param clientPhone The phone number to send the WhatsApp message to.
     */
    private void createAndSendFullCatalogueMessage(List<QuoteItem> quoteItems, String clientName, String clientPhone) {
        if (quoteItems.isEmpty()) {
             JOptionPane.showMessageDialog(this, "The catalogue list is empty.", "Catalogue Empty", JOptionPane.INFORMATION_MESSAGE);
             return;
        }
        
        StringBuilder messageBuilder = new StringBuilder();
        messageBuilder.append(String.format("Hello %s,\n\nHere is the full list of our available books and unit costs:\n\n", clientName));

        // Build the itemized list
        int count = 1;
        for (QuoteItem item : quoteItems) {
            Book book = item.getBook();
            String unitCostFormatted = String.format("Kshs. %,.0f", book.getCostPerBook()); 
            
            // BOLD Book Name
            messageBuilder.append(String.format("*(%d).* *\"%s\"* \n- Unit Cost: *%s*\n- Pages: %d (%d Color)\n- Size: Code %s\n\n", 
                count++, 
                book.getBookName().replace("\"", ""), 
                unitCostFormatted,
                book.totalPages,
                book.colorPages,
                book.pageSize));
        }

        // Append Notes
        messageBuilder.append("For a custom quote, delivery, or further details, please contact us.\n");
        // BOLD Till Number
        messageBuilder.append("- *Till No: " + TILL_NUMBER + "*");


        String message = messageBuilder.toString();
        String encodedMessage = URLEncoder.encode(message, java.nio.charset.StandardCharsets.UTF_8);

        // 3. Construct the WhatsApp URL using the provided clientPhone
        String whatsappUrl = String.format("https://wa.me/%s?text=%s", clientPhone.replace("+", ""), encodedMessage);
        
        // 4. Open the browser
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(whatsappUrl));
            } else {
                JOptionPane.showMessageDialog(this, 
                    "Browser action not supported on this system. Catalogue message:\n\n" + message, 
                    "System Error", JOptionPane.ERROR_MESSAGE);
            }
        } catch (Exception e) {
            JOptionPane.showMessageDialog(this, 
                "Could not open WhatsApp link in browser. Error: " + e.getMessage(), 
                "Communication Error", JOptionPane.ERROR_MESSAGE);
        }
    }

    // --- Cost Calculation Functions (Omitted for brevity but unchanged) ---
    
    private double insertCalculator(int totalPages, int colorPages, String pageCode) {
        int blackPages = totalPages - colorPages; 
        double costCalc;
        
        String code = pageCode.substring(0, 1);
        
        switch (code) {
            case "1":
                costCalc = (blackPages * 1.2) + (colorPages * 1.0);
                break;
            case "2":
                costCalc = (blackPages * 2.4) + (colorPages * 10.0);
                break;
            case "3":
                costCalc = (blackPages * 0.6) + (colorPages * 2.5);
                break;
            default:
                throw new IllegalArgumentException("Invalid print code. Accepted values are 1, 2, or 3.");
        }
        return costCalc;
    }
    
    private double digitalConstantCostCal(String pageCode) {
        double cover, binding, finishing;
        
        String code = pageCode.substring(0, 1);
        
        switch (code) {
            case "1":
                cover = 30.0;
                binding = 100.0;
                finishing = 80.0;
                break;
            case "2":
                cover = 50.0;
                binding = 150.0;
                finishing = 80.0;
                break;
            case "3":
                cover = 15.0;
                binding = 50.0;
                finishing = 50.0;
                break;
            default:
                throw new IllegalArgumentException("Invalid print code. Accepted values are 1, 2, or 3.");
        }
        return cover + binding + finishing;
    }

    private double calculateCost(int totalPages, int colorPages, String pageSizeCode) {
        double insertCost = insertCalculator(totalPages, colorPages, pageSizeCode);
        double constantCost = digitalConstantCostCal(pageSizeCode);
        double costPerBook = insertCost + constantCost;
        
        // Round to nearest 5 shillings
        return Math.ceil(costPerBook / 5.0) * 5.0;
    }
    
    // --- Catalogue Management (CSV I/O) (Omitted for brevity but unchanged) ---
    
    private void appendBookToCatalogue(Book book) throws IOException {
        try (FileWriter fw = new FileWriter(CSV_FILE_PATH, true)) { 
            fw.write(book.toCSVString());
        }
    }
    
    private void rewriteCatalogueToCSV() throws IOException {
        try (FileWriter fw = new FileWriter(CSV_FILE_PATH, false)) { 
            fw.write("Book Name,Total Pages,Color Pages,Size,Cost Per Book\n");
            for (Book book : catalogue) {
                fw.write(book.toCSVString());
            }
        }
    }
    
    private void deleteSelectedBook() {
        int selectedRow = catalogueTable.getSelectedRow();
        if (selectedRow == -1) {
            JOptionPane.showMessageDialog(this, "Please select a book in the table to delete.", "Selection Required", JOptionPane.WARNING_MESSAGE);
            return;
        }
        String bookName = catalogue.get(selectedRow).getBookName();

        int confirm = JOptionPane.showConfirmDialog(this, 
            "Are you sure you want to permanently delete the book: " + bookName + "?", 
            "Confirm Deletion", JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE);

        if (confirm == JOptionPane.YES_OPTION) {
            try {
                catalogue.remove(selectedRow);
                rewriteCatalogueToCSV(); 
                loadAndSortCatalogue();
                JOptionPane.showMessageDialog(this, bookName + " has been successfully deleted.", "Deletion Successful", JOptionPane.INFORMATION_MESSAGE);
            } catch (IOException ex) {
                JOptionPane.showMessageDialog(this, "Error rewriting catalogue file after deletion: " + ex.getMessage(), "File Error", JOptionPane.ERROR_MESSAGE);
            }
        }
    }

    private void loadAndSortCatalogue() {
        catalogue.clear();
        tableModel.setRowCount(0);
        
        File csvFile = new File(CSV_FILE_PATH);
        if (!csvFile.exists()) {
             try {
                rewriteCatalogueToCSV(); 
             } catch (IOException e) {
                 System.err.println("Could not create initial CSV file: " + e.getMessage());
             }
             return;
        }
        
        String line;
        int lineNumber = 0;
        try (BufferedReader br = new BufferedReader(new FileReader(csvFile))) {
            br.readLine(); 
            lineNumber++;

            while ((line = br.readLine()) != null) {
                lineNumber++;
                if (line.trim().isEmpty()) continue;
                
                Matcher matcher = CSV_PATTERN.matcher(line);
                
                if (matcher.find()) {
                    String bookName = matcher.group(1).trim();
                    int totalPages = Integer.parseInt(matcher.group(2).trim().replace(",", ""));
                    int colorPages = Integer.parseInt(matcher.group(3).trim().replace(",", ""));
                    String pageSize = matcher.group(4).trim();
                    double costPerBook = Double.parseDouble(matcher.group(5).trim().replace(",", ""));

                    Book book = new Book(bookName, totalPages, colorPages, pageSize, costPerBook);
                    catalogue.add(book);
                } else {
                    System.err.println("Skipping line " + lineNumber + " due to unexpected format: " + line);
                }
            }
            
            Collections.sort(catalogue, Comparator.comparing(Book::getBookName));
            
            for (Book book : catalogue) {
                tableModel.addRow(book.toArray());
            }

        } catch (IOException e) {
            JOptionPane.showMessageDialog(this, 
                "Error reading CSV file. Ensure '" + CSV_FILE_PATH + "' exists.\nError: " + e.getMessage(), 
                "File Error", JOptionPane.ERROR_MESSAGE);
        } catch (NumberFormatException e) {
             JOptionPane.showMessageDialog(this, 
                "A critical error occurred while parsing a number in the CSV file.\nError on line " + lineNumber + ": " + e.getMessage(), 
                "CRITICAL DATA ERROR", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    // --- New Book Input UI (Omitted for brevity but unchanged) ---

    private JPanel createNewBookPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBorder(BorderFactory.createTitledBorder("Add New Book (Manual Pages)"));
        GridBagConstraints gbc = new GridBagConstraints();
        gbc.insets = new Insets(5, 5, 5, 5);
        gbc.fill = GridBagConstraints.HORIZONTAL;
        
        // --- Row 0: File Path and Chooser (for name suggestion) ---
        gbc.gridx = 0; gbc.gridy = 0; gbc.weightx = 0;
        panel.add(new JLabel("File Path:"), gbc);
        pdfPathField = new JTextField(30);
        pdfPathField.setEditable(false);
        gbc.gridx = 1; gbc.weightx = 1.0; 
        panel.add(pdfPathField, gbc);
        
        JButton chooseFileButton = new JButton("Choose File...");
        chooseFileButton.addActionListener(e -> chooseFile());
        gbc.gridx = 2; gbc.weightx = 0;
        panel.add(chooseFileButton, gbc);

        // --- Row 1: Book Name and Total Pages ---
        gbc.gridx = 0; gbc.gridy = 1; 
        panel.add(new JLabel("Book Name:"), gbc);
        bookNameField = new JTextField(30);
        gbc.gridx = 1; gbc.weightx = 1.0; 
        panel.add(bookNameField, gbc);
        
        gbc.gridx = 3; gbc.weightx = 0;
        panel.add(new JLabel("Total Pages:"), gbc);
        totalPagesField = new JTextField(5);
        gbc.gridx = 4; gbc.weightx = 0.5;
        panel.add(totalPagesField, gbc);

        // --- Row 2: Color Pages, Print Code, and Button ---
        gbc.gridx = 3; gbc.gridy = 2; gbc.weightx = 0;
        panel.add(new JLabel("Color Pages:"), gbc);
        colorPagesField = new JTextField(5);
        gbc.gridx = 4; gbc.weightx = 0.5;
        panel.add(colorPagesField, gbc);

        gbc.gridx = 0; gbc.gridy = 2; gbc.weightx = 0;
        panel.add(new JLabel("Print Code:"), gbc);
        String[] sizes = {"1 (A5/B5)", "2 (A4 Standard)", "3 (A3/Large)"};
        pageSizeComboBox = new JComboBox<>(sizes);
        pageSizeComboBox.setSelectedItem("2 (A4 Standard)");
        gbc.gridx = 1; gbc.weightx = 1.0;
        panel.add(pageSizeComboBox, gbc);
        
        // Add Book Button
        JButton addButton = new JButton("Calculate & Add to Catalogue");
        addButton.setBackground(new Color(255, 100, 100)); 
        addButton.setForeground(Color.WHITE);
        addButton.setFont(new Font("SansSerif", Font.BOLD, 14));
        addButton.setFocusPainted(false);
        addButton.addActionListener(e -> processNewBook());
        
        gbc.gridx = 2; gbc.gridy = 0; gbc.weightx = 0; gbc.gridheight = 2; 
        gbc.fill = GridBagConstraints.VERTICAL;
        panel.add(addButton, gbc);

        return panel;
    }
    
    private void chooseFile() {
        JFileChooser fileChooser = new JFileChooser();
        int result = fileChooser.showOpenDialog(this);
        
        if (result == JFileChooser.APPROVE_OPTION) {
            File selectedFile = fileChooser.getSelectedFile();
            pdfPathField.setText(selectedFile.getAbsolutePath());
            
            String fileName = selectedFile.getName();
            int dotIndex = fileName.lastIndexOf('.');
            String nameWithoutExtension = (dotIndex == -1) ? fileName : fileName.substring(0, dotIndex);
            String suggestedName = nameWithoutExtension.replaceAll("[_-]", " ").trim();
            bookNameField.setText(suggestedName);
        }
    }

    private void processNewBook() {
        String bookName = bookNameField.getText().trim();
        String pageSizeCode = (String) pageSizeComboBox.getSelectedItem();

        if (bookName.isEmpty() || totalPagesField.getText().trim().isEmpty() || colorPagesField.getText().trim().isEmpty()) {
            JOptionPane.showMessageDialog(this, "Please fill in all required fields (Name, Total Pages, Color Pages).", "Input Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        try {
            int totalPages = Integer.parseInt(totalPagesField.getText().trim());
            int colorPages = Integer.parseInt(colorPagesField.getText().trim());

            if (totalPages <= 0 || colorPages < 0 || colorPages > totalPages) {
                JOptionPane.showMessageDialog(this, "Page counts must be valid (Total > 0, Color >= 0, Color <= Total).", "Input Error", JOptionPane.ERROR_MESSAGE);
                return;
            }
            
            double costPerBook = calculateCost(totalPages, colorPages, pageSizeCode);
            
            String csvPageSize = pageSizeCode.substring(0, 1);
            Book newBook = new Book(bookName, totalPages, colorPages, csvPageSize, costPerBook);
            appendBookToCatalogue(newBook);
            
            loadAndSortCatalogue();
            JOptionPane.showMessageDialog(this, 
                String.format("New book added:\nName: %s\nTotal Pages: %d\nUnit Cost: Kshs. %.2f", 
                    bookName, totalPages, costPerBook), 
                "Book Added Successfully", JOptionPane.INFORMATION_MESSAGE);

        } catch (NumberFormatException e) {
             JOptionPane.showMessageDialog(this, 
                "Invalid page numbers entered. Please use whole numbers for Total Pages and Color Pages.", 
                "Input Error", JOptionPane.ERROR_MESSAGE);
        } catch (Exception e) {
             JOptionPane.showMessageDialog(this, 
                "An error occurred during processing:\n" + e.getMessage(), 
                "Processing Error", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    /**
     * Generates the WhatsApp message string for the provided list of QUOTE items, 
     * including totals, discounts, and minimum cost checks, and opens the default browser.
     * @param clientPhone The client's phone number to send the quote to.
     */
    private void createAndSendQuoteMessage(List<QuoteItem> quoteItems, double discount, double finalTotal, String clientName, String clientPhone) {
        if (quoteItems.isEmpty()) {
             JOptionPane.showMessageDialog(this, "No books were found in the quote cart.", "Quote Empty", JOptionPane.INFORMATION_MESSAGE);
             return;
        }
        
        StringBuilder messageBuilder = new StringBuilder();
        messageBuilder.append(String.format("Hello %s, Thank you for your enquiry,\nFind the below quote:\n\n", clientName));

        double subtotal = 0.0;
        
        // Build the itemized list
        int count = 1;
        for (QuoteItem item : quoteItems) {
            double lineTotal = item.getLineTotal();
            subtotal += lineTotal;
            
            String unitCostFormatted = String.format("Kshs. %,.0f", item.getBook().getCostPerBook()); 
            String lineTotalFormatted = String.format("Kshs. %,.0f", lineTotal); 
            
            // Determine Copie(s) pluralization
            String copiesText = (item.getQuantity() == 1) ? "Copie" : "Copies";
            
            // BOLD Book Name
            messageBuilder.append(String.format("*(%d).* %d %s of *\"%s\"* \nCosts per book: %s\nTotal: %s\n\n", 
                count++, 
                item.getQuantity(),
                copiesText,
                item.getBook().getBookName().replace("\"", ""), // BOLDED
                unitCostFormatted,
                lineTotalFormatted));
        }

        // Append Totals and Notes (Formatting to whole shillings)
        messageBuilder.append("\n"); // Extra space before totals

        String discountFormatted = String.format("Kshs. %,.0f", discount);
        String subtotalFormatted = String.format("Kshs. %,.0f", subtotal);
        String totalInvoiceFormatted = String.format("Kshs. %,.0f", finalTotal);

        messageBuilder.append(String.format("Subtotal: %s\n", subtotalFormatted));
        messageBuilder.append(String.format("Discount: %s\n", discountFormatted));
        
        // Add Minimum Cost note if applied
        if (finalTotal == MINIMUM_COST && subtotal - discount < MINIMUM_COST) {
             messageBuilder.append(String.format("*(Note: Minimum order cost of Kshs. %,.0f applied)*\n", MINIMUM_COST));
        }
        
        // BOLD TOTAL INVOICE
        messageBuilder.append(String.format("*TOTAL INVOICE*: *%s*\n\n", totalInvoiceFormatted));
        
        // Add Notes
        messageBuilder.append("NOTE:\n");
        messageBuilder.append("- PRODUCTION BEGINS AFTER RECEIPT OF PAYMENT\n");
        messageBuilder.append("- DELIVERY WITHIN 2 WORKING DAYS\n\n");
        // BOLD Till Number
        messageBuilder.append("- *Till No: " + TILL_NUMBER + "*");


        String message = messageBuilder.toString();
        String encodedMessage = URLEncoder.encode(message, java.nio.charset.StandardCharsets.UTF_8);

        // 3. Construct the WhatsApp URL using the recipient's phone number
        String whatsappUrl = String.format("https://wa.me/%s?text=%s", clientPhone.replace("+", ""), encodedMessage);
        
        // 4. Open the browser
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(whatsappUrl));
            } else {
                JOptionPane.showMessageDialog(this, 
                    "Browser action not supported on this system. Quote message:\n\n" + message, 
                    "System Error", JOptionPane.ERROR_MESSAGE);
            }
        } catch (Exception e) {
            JOptionPane.showMessageDialog(this, 
                "Could not open WhatsApp link in browser. Error: " + e.getMessage(), 
                "Communication Error", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    // -------------------------------------------------------------------------
    // --- QuoteBuilderDialog (The Shopping Cart View) -------------------------
    // -------------------------------------------------------------------------

    private class QuoteBuilderDialog extends JDialog implements TableModelListener {
        
        private CatalogueManager parentFrame; // Reference to the main window
        private List<QuoteItem> quoteItems;
        private DefaultTableModel cartModel;
        private JTable cartTable; // Reference to the shopping cart table
        
        // NEW FIELDS for Client Information
        private JTextField clientNameField;
        private JTextField phoneNumberField;
        
        private JTextField discountField;
        private JLabel subtotalLabel;
        private JLabel finalTotalLabel;
        private JLabel minCostWarningLabel;
        private double currentDiscount = 0.0;
        
        private final String[] CART_COLUMNS = {"Book Name", "Unit Cost", "Quantity", "Line Total"};

        public QuoteBuilderDialog(JFrame parent, List<QuoteItem> items) {
            super(parent, "Quote Builder / Shopping Cart", true);
            this.parentFrame = (CatalogueManager) parent; // Store reference to the main frame
            this.quoteItems = items;
            
            setSize(850, 550); // Increased height for new fields
            setLocationRelativeTo(parent);
            setLayout(new BorderLayout(10, 10));
            getRootPane().setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15));

            setupCartTable();
            cartTable = new JTable(cartModel);
            cartTable.setFillsViewportHeight(true);
            cartTable.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);
            
            // Set preferred widths
            cartTable.getColumnModel().getColumn(2).setPreferredWidth(60); 
            cartTable.getColumnModel().getColumn(3).setPreferredWidth(100); 

            add(new JScrollPane(cartTable), BorderLayout.CENTER);
            add(createTotalPanel(), BorderLayout.SOUTH); 
            
            recalculateTotals(); // Initial calculation
        }
        
        /**
         * Prompts the user with a dropdown list of available books and adds the 
         * selected one to the quote cart.
         */
        private void promptAndAddBook() {
            // 1. Get list of available book names, excluding those already in the quote
            List<Book> fullCatalogue = parentFrame.catalogue;
            Set<String> existingBookNames = new HashSet<>();
            for (QuoteItem item : quoteItems) {
                existingBookNames.add(item.getBook().getBookName());
            }

            List<String> availableNames = new ArrayList<>();
            for (Book book : fullCatalogue) {
                // Only list books not already in the quote
                if (!existingBookNames.contains(book.getBookName())) {
                    availableNames.add(book.getBookName());
                }
            }
            
            if (availableNames.isEmpty()) {
                JOptionPane.showMessageDialog(this, 
                    "All available books are already included in this quote.", 
                    "No Books Available", JOptionPane.INFORMATION_MESSAGE);
                return;
            }

            // 2. Create ComboBox
            JComboBox<String> bookSelector = new JComboBox<>(availableNames.toArray(new String[0]));
            bookSelector.setEditable(false);
            
            // 3. Show dialog using JOptionPane to present the dropdown
            int result = JOptionPane.showConfirmDialog(
                this,
                new Object[] {"Select the book you wish to add:", bookSelector},
                "Add Book to Quote",
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.PLAIN_MESSAGE
            );
            
            // 4. Handle selection
            if (result == JOptionPane.OK_OPTION && bookSelector.getSelectedItem() != null) {
                String selectedName = (String) bookSelector.getSelectedItem();
                
                // Find the Book object matching the selected name
                Book bookToAdd = fullCatalogue.stream()
                    .filter(b -> b.getBookName().equals(selectedName))
                    .findFirst()
                    .orElse(null);

                if (bookToAdd != null) {
                    QuoteItem newItem = new QuoteItem(bookToAdd, 1); // Default quantity of 1
                    quoteItems.add(newItem);
                    cartModel.addRow(newItem.toArray());
                    recalculateTotals();
                    JOptionPane.showMessageDialog(this, "\"" + selectedName + "\" added to the quote.", "Book Added", JOptionPane.INFORMATION_MESSAGE);
                }
            }
        }
        
        /**
         * Logic for removing selected items from the cart table.
         */
        private void removeSelectedItems() {
            int[] selectedRows = cartTable.getSelectedRows();
            if (selectedRows.length == 0) {
                JOptionPane.showMessageDialog(this, "Please select item(s) to remove from the cart table.", "Selection Required", JOptionPane.WARNING_MESSAGE);
                return;
            }

            int removedCount = selectedRows.length;
            // Remove from highest index downwards to avoid index shifting issues
            for (int i = selectedRows.length - 1; i >= 0; i--) {
                int rowToRemove = selectedRows[i];
                if (rowToRemove < quoteItems.size()) {
                    quoteItems.remove(rowToRemove);
                    cartModel.removeRow(rowToRemove);
                }
            }
            
            recalculateTotals();
            JOptionPane.showMessageDialog(this, removedCount + " item(s) removed from the quote.", "Items Removed", JOptionPane.INFORMATION_MESSAGE);
        }

        private void setupCartTable() {
            cartModel = new DefaultTableModel(CART_COLUMNS, 0) {
                @Override
                public boolean isCellEditable(int row, int column) {
                    // Only the Quantity column (index 2) is editable
                    return column == 2; 
                }
                @Override
                public Class<?> getColumnClass(int columnIndex) {
                    // Quantity column is Integer for easier handling
                    if (columnIndex == 2) return Integer.class;
                    return String.class;
                }
            };
            
            // Populate the cart model with initial items
            for (QuoteItem item : quoteItems) {
                cartModel.addRow(item.toArray());
            }
            
            // Listen for changes in the table (i.e., quantity edits)
            cartModel.addTableModelListener(this);
        }

        @Override
        public void tableChanged(TableModelEvent e) {
            if (e.getType() == TableModelEvent.UPDATE && e.getColumn() == 2) {
                int row = e.getFirstRow();
                try {
                    // Get the new quantity value
                    Integer newQty = (Integer) cartModel.getValueAt(row, 2);
                    
                    if (newQty != null && newQty >= 1) {
                        // Update the internal QuoteItem
                        quoteItems.get(row).setQuantity(newQty);
                        
                        // Recalculate and update the Line Total column immediately
                        double newLineTotal = quoteItems.get(row).getLineTotal();
                        cartModel.setValueAt(String.format("Kshs. %,.0f", newLineTotal), row, 3);
                        
                        recalculateTotals();
                    } else {
                        // Revert the UI if input is invalid (e.g., negative or zero)
                        cartModel.setValueAt(quoteItems.get(row).getQuantity(), row, 2);
                        JOptionPane.showMessageDialog(this, "Quantity must be 1 or greater.", "Input Error", JOptionPane.WARNING_MESSAGE);
                    }
                } catch (ClassCastException | NumberFormatException ex) {
                    // Handle non-integer input by reverting the cell
                    cartModel.setValueAt(quoteItems.get(row).getQuantity(), row, 2); 
                    JOptionPane.showMessageDialog(this, "Please enter a valid whole number for quantity.", "Input Error", JOptionPane.ERROR_MESSAGE);
                }
            }
        }
        
        private JPanel createTotalPanel() {
            JPanel bottomContainer = new JPanel(new BorderLayout(15, 15));

            // 1. Client Information Panel (NEW)
            JPanel clientInfoPanel = new JPanel(new GridLayout(1, 4, 10, 5));
            clientNameField = new JTextField(20);
            phoneNumberField = new JTextField(15);
            
            // Add initial placeholders or guidance
            phoneNumberField.setText("+254");
            
            clientInfoPanel.add(new JLabel("Client Name:"));
            clientInfoPanel.add(clientNameField);
            clientInfoPanel.add(new JLabel("Client Phone (Recipient):"));
            clientInfoPanel.add(phoneNumberField);

            bottomContainer.add(clientInfoPanel, BorderLayout.NORTH);

            // 2. Middle Row: Action Buttons (WEST) and Totals (CENTER)
            JPanel middleRow = new JPanel(new BorderLayout(10, 10));
            
            // --- Action Buttons (WEST) ---
            JPanel actionButtons = new JPanel(new GridLayout(2, 1, 10, 10));
            
            JButton addMoreButton = new JButton("Add More Books (Dropdown)");
            addMoreButton.setBackground(new Color(60, 140, 200));
            addMoreButton.setForeground(Color.WHITE);
            addMoreButton.setFont(new Font("SansSerif", Font.BOLD, 14));
            // Updated action listener to use the dropdown prompt
            addMoreButton.addActionListener(e -> promptAndAddBook()); 
            
            JButton removeSelectedButton = new JButton("Remove Selected");
            removeSelectedButton.setBackground(new Color(220, 50, 50));
            removeSelectedButton.setForeground(Color.WHITE);
            removeSelectedButton.setFont(new Font("SansSerif", Font.BOLD, 14));
            removeSelectedButton.addActionListener(e -> removeSelectedItems());
            
            actionButtons.add(addMoreButton);
            actionButtons.add(removeSelectedButton);
            middleRow.add(actionButtons, BorderLayout.WEST);

            // --- Totals Grid (CENTER) ---
            JPanel totalsGrid = new JPanel(new GridLayout(3, 2, 5, 5));
            
            subtotalLabel = new JLabel("Kshs. 0");
            subtotalLabel.setFont(new Font("SansSerif", Font.BOLD, 14));
            subtotalLabel.setHorizontalAlignment(SwingConstants.RIGHT);
            
            finalTotalLabel = new JLabel("Kshs. 0");
            finalTotalLabel.setFont(new Font("SansSerif", Font.BOLD, 18));
            finalTotalLabel.setForeground(new Color(40, 170, 70));
            finalTotalLabel.setHorizontalAlignment(SwingConstants.RIGHT);

            discountField = new JTextField(String.format("%,.0f", currentDiscount));
            discountField.setHorizontalAlignment(SwingConstants.RIGHT);
            // Listener for discount changes
            discountField.addActionListener(e -> updateDiscountAndRecalculate());
            discountField.addFocusListener(new java.awt.event.FocusAdapter() {
                public void focusLost(java.awt.event.FocusEvent e) {
                    updateDiscountAndRecalculate();
                }
            });
            
            totalsGrid.add(new JLabel("SUBTOTAL:", SwingConstants.RIGHT));
            totalsGrid.add(subtotalLabel);
            
            totalsGrid.add(new JLabel("Discount (Kshs.):", SwingConstants.RIGHT));
            totalsGrid.add(discountField);
            
            totalsGrid.add(new JLabel("TOTAL INVOICE:", SwingConstants.RIGHT));
            totalsGrid.add(finalTotalLabel);

            middleRow.add(totalsGrid, BorderLayout.CENTER);

            bottomContainer.add(middleRow, BorderLayout.CENTER); // Changed to CENTER

            // 3. Bottom Row: Warning and Send Button
            JPanel sendPanel = new JPanel(new BorderLayout(0, 5));
            minCostWarningLabel = new JLabel("", SwingConstants.CENTER);
            minCostWarningLabel.setForeground(Color.RED);
            minCostWarningLabel.setFont(new Font("SansSerif", Font.ITALIC, 12));
            sendPanel.add(minCostWarningLabel, BorderLayout.NORTH);
            
            JButton sendQuoteButton = new JButton("Generate & Send Quote (WhatsApp)");
            sendQuoteButton.setBackground(new Color(40, 170, 70));
            sendQuoteButton.setForeground(Color.WHITE);
            sendQuoteButton.setFont(new Font("SansSerif", Font.BOLD, 16));
            sendQuoteButton.addActionListener(e -> finalizeAndSend());
            sendPanel.add(sendQuoteButton, BorderLayout.SOUTH);

            bottomContainer.add(sendPanel, BorderLayout.SOUTH);
            
            return bottomContainer;
        }
        
        private void updateDiscountAndRecalculate() {
             try {
                // Remove commas for clean parsing
                String text = discountField.getText().trim().replace(",", "");
                double newDiscount = Double.parseDouble(text);
                if (newDiscount < 0) {
                     JOptionPane.showMessageDialog(this, "Discount cannot be negative. Setting to 0.", "Input Error", JOptionPane.ERROR_MESSAGE);
                     currentDiscount = 0.0;
                } else {
                     currentDiscount = newDiscount;
                }
                // Update text field format
                discountField.setText(String.format("%,.0f", currentDiscount));
                recalculateTotals();
            } catch (NumberFormatException ex) {
                JOptionPane.showMessageDialog(this, "Please enter a valid number for the discount.", "Input Error", JOptionPane.ERROR_MESSAGE);
                discountField.setText(String.format("%,.0f", currentDiscount)); // Revert to last valid value
            }
        }

        private void recalculateTotals() {
            double subtotal = quoteItems.stream()
                .mapToDouble(QuoteItem::getLineTotal)
                .sum();
            
            double preFinalTotal = subtotal - currentDiscount;
            double finalTotal;
            
            String warningText = "";

            if (preFinalTotal < MINIMUM_COST) {
                finalTotal = MINIMUM_COST;
                warningText = String.format("Minimum order cost of Kshs. %,.0f applied.", MINIMUM_COST);
                minCostWarningLabel.setForeground(Color.RED);
            } else {
                finalTotal = preFinalTotal;
                warningText = "Minimum cost requirement met.";
                minCostWarningLabel.setForeground(new Color(40, 170, 70));
            }
            
            // Update UI Labels (Formatting to whole shillings)
            subtotalLabel.setText(String.format("Kshs. %,.0f", subtotal));
            finalTotalLabel.setText(String.format("Kshs. %,.0f", finalTotal));
            minCostWarningLabel.setText(warningText);
        }

        private void finalizeAndSend() {
             if (quoteItems.isEmpty()) {
                JOptionPane.showMessageDialog(this, "Your shopping cart is empty. Please add books to create a quote.", "Cart Empty", JOptionPane.WARNING_MESSAGE);
                return;
            }
            
            // 1. Get Client Info from fields
            String name = clientNameField.getText().trim();
            String phone = phoneNumberField.getText().trim();
            
            if (name.isEmpty()) {
                JOptionPane.showMessageDialog(this, "Please enter the client's name.", "Input Required", JOptionPane.WARNING_MESSAGE);
                return; 
            }
            // Basic phone validation: non-empty and starts with a '+' or a digit (allowing for +254 or 07...)
            if (phone.isEmpty() || !phone.matches("^\\+?\\d.*")) { 
                 JOptionPane.showMessageDialog(this, "Please enter a valid phone number (e.g., +2547...).", "Input Required", JOptionPane.WARNING_MESSAGE);
                 return; 
            }
            
            // Re-run final calculation to ensure UI is up to date
            recalculateTotals(); 
            
            double subtotal = quoteItems.stream().mapToDouble(QuoteItem::getLineTotal).sum();
            double preFinalTotal = subtotal - currentDiscount;
            double finalTotal = (preFinalTotal < MINIMUM_COST) ? MINIMUM_COST : preFinalTotal;

            
            // 2. Pass final, calculated data and new inputs to the CatalogueManager method
            CatalogueManager.this.createAndSendQuoteMessage(quoteItems, currentDiscount, finalTotal, name, phone);
            
            // Close the dialog after sending
            dispose();
        }
    }
    
    // --- Main Entry Point ---

    public static void main(String[] args) {
        SwingUtilities.invokeLater(CatalogueManager::new);
    }
}