import javax.swing.*;
import javax.swing.table.DefaultTableModel;
import java.awt.*;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder; 
import java.nio.charset.StandardCharsets; 
import java.text.DecimalFormat; 
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors; 

/**
 * CatalogueManager.java - The main entry point and UI coordinator.
 * Manages the JFrame, JTabbedPane, and orchestrates interactions between 
 * CatalogueService, CostCalculator, and QuoteBuilderDialog.
 */
public class CatalogueManager extends JFrame {

    // --- Constants ---
    private static final String CSV_FILE_PATH = "books_catalogue.csv";
    private static final String DEFAULT_SENDER_PHONE = "+254748217344"; 
    private static final double MINIMUM_COST = 400.0;
    private static final String TILL_NUMBER = "5675635";
    
    // Global format for currency/costs
    private static final DecimalFormat DECIMAL_FORMAT = new DecimalFormat("#,##0.00");
    
    // --- Services and State ---
    private final CatalogueService catalogueService = new CatalogueService(CSV_FILE_PATH);
    // This list holds the entire catalogue data and is kept in sync with the CSV/table
    private List<Book> catalogue = new ArrayList<>(); 
    
    // UI components for new book entry (Add to Catalogue Tab)
    private JTextField pdfPathField;
    private JTextField bookNameField;
    private JTextField totalPagesField; 
    private JTextField colorPagesField; 
    private JComboBox<String> pageSizeComboBox;

    // UI components for Quick Calculator Tab
    private JTextField quickTotalPagesField;
    private JTextField quickColorPagesField;
    private JComboBox<String> quickPageSizeComboBox;
    private JLabel quickCostResultLabel;
    
    // UI components for Catalogue Table
    private JTable catalogueTable; 
    private DefaultTableModel tableModel;
    
    private final String[] SIZE_OPTIONS = {"1 (A5/B5)", "2 (A4 Standard)", "3 (A6/Large)"};
    
    // Getter for the catalogue list 
    public List<Book> getCatalogue() {
        return catalogue;
    }

    // --- Constructor & UI Initialization ---

    public CatalogueManager() {
        setTitle("Books Printing Catalogue/ Quote Calculator");
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setSize(1200, 800); 
        setLocationRelativeTo(null); 
        
        getRootPane().setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15)); 

        // 1. Initialize Table Model
        String[] columnNames = {"Book Name", "Pages", "Color", "Size", "Unit Cost"};
        tableModel = new DefaultTableModel(columnNames, 0) {
            @Override
            public boolean isCellEditable(int row, int column) { return false; }
        };
        catalogueTable = new JTable(tableModel);
        catalogueTable.setFillsViewportHeight(true);
        catalogueTable.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);

        // 2. Create the Tabbed Pane
        JTabbedPane tabbedPane = new JTabbedPane();
        tabbedPane.addTab("Catalogue Manager", createCataloguePanel());
        tabbedPane.addTab("Quick Cost Calculator", createQuickCalculatorPanel());
        tabbedPane.addTab("Offset Calculator", new OffsetCalculatorPanel());
        tabbedPane.addTab("Constant Costs", setConstantsPanel());
        
        // 3. Set up Layout
        setLayout(new BorderLayout(20, 20)); 
        add(tabbedPane, BorderLayout.CENTER);
        add(createControlPanel(), BorderLayout.SOUTH);

        setVisible(true);
        loadCatalogueData(); 
    }
    
    // --- Catalogue Panel (Tab 1) Methods ---

    private JPanel createCataloguePanel() {
        JPanel cataloguePanel = new JPanel(new BorderLayout(10, 10));
        cataloguePanel.add(createNewBookPanel(), BorderLayout.NORTH);
        cataloguePanel.add(new JScrollPane(catalogueTable), BorderLayout.CENTER);
        return cataloguePanel;
    }
    
    private JPanel createNewBookPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBorder(BorderFactory.createTitledBorder("Add New Book to Catalogue (Calculate & Save)"));
        GridBagConstraints gbc = new GridBagConstraints();
        gbc.insets = new Insets(5, 5, 5, 5);
        gbc.fill = GridBagConstraints.HORIZONTAL;
        
        // Row 0: File Path and Chooser 
        gbc.gridx = 0; gbc.gridy = 0; gbc.weightx = 0;
        panel.add(new JLabel("File Path:"), gbc);
        pdfPathField = new JTextField(30);
        pdfPathField.setEditable(false);
        gbc.gridx = 1; gbc.weightx = 1.0; 
        panel.add(pdfPathField, gbc);
        
        JButton chooseFileButton = new JButton("Choose File...");
        chooseFileButton.addActionListener(e -> chooseFile());
        // Option: Navy Blue Background (Used this one)
        // chooseFileButton.setBackground(new Color(0, 51, 102)); // Dark Navy Blue
        chooseFileButton.setBackground(new Color(0, 51, 102)); // Alternative: Dark Maroon
        chooseFileButton.setForeground(Color.BLUE); // White Font
        chooseFileButton.setFont(new Font("SansSerif", Font.BOLD, 12));
        // chooseFileButton.setFocusPainted(false); // Aesthetic improvement
        gbc.gridx = 2; gbc.weightx = 0;
        panel.add(chooseFileButton, gbc);


        // Row 1: Book Name and Total Pages
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

        // Row 2: Color Pages, Print Code, and Button
        gbc.gridx = 3; gbc.gridy = 2; gbc.weightx = 0;
        panel.add(new JLabel("Color Pages:"), gbc);
        colorPagesField = new JTextField(5);
        gbc.gridx = 4; gbc.weightx = 0.5;
        panel.add(colorPagesField, gbc);

        gbc.gridx = 0; gbc.gridy = 2; gbc.weightx = 0;
        panel.add(new JLabel("Print Code:"), gbc);
        pageSizeComboBox = new JComboBox<>(SIZE_OPTIONS);
        pageSizeComboBox.setSelectedItem(SIZE_OPTIONS[0]);
        gbc.gridx = 1; gbc.weightx = 1.0;
        panel.add(pageSizeComboBox, gbc);
        
        JButton addButton = new JButton("Calculate & Add to Catalogue");
        addButton.setBackground(new Color(255, 100, 100)); 
        addButton.setForeground(Color.black);
        addButton.setFont(new Font("SansSerif", Font.BOLD, 14));
        addButton.setFocusPainted(false);
        addButton.addActionListener(e -> processNewBook());
        
        gbc.gridx = 2; gbc.gridy = 1; gbc.weightx = 0; gbc.gridheight = 2; 
        gbc.fill = GridBagConstraints.VERTICAL;
        panel.add(addButton, gbc);

        addButton.setBackground(new Color(200, 200, 250)); // Alternative: Dark Maroon
        chooseFileButton.setForeground(Color.BLUE); // White Font
        addButton.setFont(new Font("SansSerif", Font.BOLD, 12));
        // addButton.setFocusPainted(false); // Aesthetic improvement

        return panel;
    }
    
    /**
     * Opens a file chooser dialog and attempts to pre-fill the book name field.
     */
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

    /**
     * Reads input fields, calculates cost, adds book to catalogue list, saves to CSV, and refreshes the table.
     */
    private void processNewBook() {
        String bookName = bookNameField.getText().trim();
        String pageSizeCode = (String) pageSizeComboBox.getSelectedItem();

        if (bookName.isEmpty() || totalPagesField.getText().trim().isEmpty() || colorPagesField.getText().trim().isEmpty()) {
            JOptionPane.showMessageDialog(this, "Please fill in all required fields.", "Input Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        try {
            int totalPages = Integer.parseInt(totalPagesField.getText().trim());
            int colorPages = Integer.parseInt(colorPagesField.getText().trim());

            if (totalPages <= 0 || colorPages < 0 || colorPages > totalPages) {
                JOptionPane.showMessageDialog(this, "Page counts must be valid.", "Input Error", JOptionPane.ERROR_MESSAGE);
                return;
            }
            
            // Check for duplicate name
            if (catalogue.stream().anyMatch(book -> book.getBookName().equalsIgnoreCase(bookName))) {
                JOptionPane.showMessageDialog(this, "A book with this name already exists.", "Duplicate Entry", JOptionPane.ERROR_MESSAGE);
                return;
            }
            
            // Calculate cost using the external service
            double costPerBook = CostCalculator.calculateCost(totalPages, colorPages, pageSizeCode);
            
            String csvPageSize = pageSizeCode.substring(0, 1);
            Book newBook = new Book(bookName, totalPages, colorPages, csvPageSize, costPerBook);
            
            // Save the book and reload data
            catalogueService.appendBook(newBook);
            loadCatalogueData(); 
            
            JOptionPane.showMessageDialog(this, 
                String.format("New book added:\nName: %s\nUnit Cost: Kshs. %,.2f", bookName, costPerBook), 
                "Book Added Successfully", JOptionPane.INFORMATION_MESSAGE);

            // Clear fields after successful entry
            bookNameField.setText("");
            totalPagesField.setText("");
            colorPagesField.setText("");
            pdfPathField.setText("");

        } catch (NumberFormatException e) {
             JOptionPane.showMessageDialog(this, "Invalid page numbers entered. Please use whole numbers.", "Input Error", JOptionPane.ERROR_MESSAGE);
        } catch (IllegalArgumentException e) {
             JOptionPane.showMessageDialog(this, "Calculation Error: " + e.getMessage(), "Processing Error", JOptionPane.ERROR_MESSAGE);
        } catch (Exception e) {
             JOptionPane.showMessageDialog(this, "An error occurred during processing:\n" + e.getMessage(), "Processing Error", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    /**
     * Deletes the selected book from the list and rewrites the entire CSV file.
     */
    private void deleteSelectedBook() {
        int selectedRow = catalogueTable.getSelectedRow();
        if (selectedRow == -1) {
            JOptionPane.showMessageDialog(this, "Please select a book in the table to delete.", "Selection Required", JOptionPane.WARNING_MESSAGE);
            return;
        }
        
        int modelRow = catalogueTable.convertRowIndexToModel(selectedRow); 
        String bookName = catalogue.get(modelRow).getBookName();

        int confirm = JOptionPane.showConfirmDialog(this, 
            "Are you sure you want to permanently delete the book: " + bookName + "?", 
            "Confirm Deletion", JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE);

        if (confirm == JOptionPane.YES_OPTION) {
            try {
                catalogue.remove(modelRow);
                catalogueService.rewriteCatalogue(catalogue); // Rewrite the whole file
                loadCatalogueData();
                JOptionPane.showMessageDialog(this, bookName + " has been successfully deleted.", "Deletion Successful", JOptionPane.INFORMATION_MESSAGE);
            } catch (IOException ex) {
                JOptionPane.showMessageDialog(this, "Error rewriting catalogue file after deletion: " + ex.getMessage(), "File Error", JOptionPane.ERROR_MESSAGE);
            }
        }
    }
    
    /**
     * Clears and reloads the catalogue data from the CSV file into the list and the JTable.
     */
    private void loadCatalogueData() {
        catalogue.clear();
        tableModel.setRowCount(0);
        
        try {
            // Load the updated catalogue list from the service
            List<Book> loadedBooks = catalogueService.loadCatalogue();
            catalogue.addAll(loadedBooks);
            
            // Repopulate the table model
            for (Book book : catalogue) {
                tableModel.addRow(book.toArray());
            }

        } catch (IOException e) {
            JOptionPane.showMessageDialog(this, 
                "Error reading CSV file. Ensure '" + CSV_FILE_PATH + "' exists.\nError: " + e.getMessage(), 
                "File Error", JOptionPane.ERROR_MESSAGE);
        } catch (NumberFormatException e) {
             JOptionPane.showMessageDialog(this, 
                "A critical error occurred while parsing data in the CSV file.\nError: " + e.getMessage(), 
                "CRITICAL DATA ERROR", JOptionPane.ERROR_MESSAGE);
        }
    }

    // --- Quick Calculator Panel (Tab 2) Methods ---
    
    private JPanel createQuickCalculatorPanel() {
        JPanel calcPanel = new JPanel(new GridBagLayout());
        calcPanel.setBorder(BorderFactory.createTitledBorder("Calculate Cost Per Book"));
        
        GridBagConstraints gbc = new GridBagConstraints();
        gbc.insets = new Insets(10, 10, 10, 10);
        gbc.anchor = GridBagConstraints.WEST;
        gbc.fill = GridBagConstraints.HORIZONTAL;

        JLabel titleLabel = new JLabel("Instant Print Cost Estimator");
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 24));
        gbc.gridx = 0; gbc.gridy = 0; gbc.gridwidth = 3; 
        calcPanel.add(titleLabel, gbc);
        
        gbc.gridy = 1; gbc.insets = new Insets(0, 0, 20, 0);
        calcPanel.add(new JSeparator(), gbc);
        
        // --- Input Fields ---
        gbc.gridwidth = 1; 
        gbc.insets = new Insets(10, 10, 10, 10);
        
        gbc.gridx = 0; gbc.gridy = 2; 
        calcPanel.add(new JLabel("Total Pages:"), gbc);
        quickTotalPagesField = new JTextField(10);
        gbc.gridx = 1; gbc.weightx = 1.0;
        calcPanel.add(quickTotalPagesField, gbc);

        gbc.gridx = 0; gbc.gridy = 3; 
        calcPanel.add(new JLabel("Color Pages:"), gbc);
        quickColorPagesField = new JTextField(10);
        gbc.gridx = 1; gbc.weightx = 1.0;
        calcPanel.add(quickColorPagesField, gbc);

        gbc.gridx = 0; gbc.gridy = 4; 
        calcPanel.add(new JLabel("Print Code:"), gbc);
        quickPageSizeComboBox = new JComboBox<>(SIZE_OPTIONS);
        quickPageSizeComboBox.setSelectedItem(SIZE_OPTIONS[0]);
        gbc.gridx = 1; gbc.weightx = 1.0;
        calcPanel.add(quickPageSizeComboBox, gbc);
        
        // --- Calculate Button ---
        JButton calculateButton = new JButton("Calculate Unit Cost (Kshs.)");
        calculateButton.setBackground(new Color(60, 140, 200));
        calculateButton.setForeground(Color.BLUE);
        calculateButton.setFont(new Font("SansSerif", Font.BOLD, 16));
        calculateButton.setFocusPainted(false);
        calculateButton.addActionListener(e -> calculateQuickCost());
        
        gbc.gridx = 0; gbc.gridy = 5; gbc.gridwidth = 2; gbc.insets = new Insets(20, 10, 20, 10);
        calcPanel.add(calculateButton, gbc);

        // --- Result Label ---
        JLabel resultTitle = new JLabel("ESTIMATED UNIT COST:");
        resultTitle.setFont(new Font("SansSerif", Font.BOLD, 18));
        gbc.gridx = 0; gbc.gridy = 6; gbc.gridwidth = 1; gbc.anchor = GridBagConstraints.EAST;
        calcPanel.add(resultTitle, gbc);

        quickCostResultLabel = new JLabel("Kshs. 0.00");
        quickCostResultLabel.setFont(new Font("SansSerif", Font.BOLD, 24));
        quickCostResultLabel.setForeground(new Color(40, 170, 70));
        gbc.gridx = 1; gbc.gridy = 6; gbc.anchor = GridBagConstraints.WEST;
        calcPanel.add(quickCostResultLabel, gbc);

        // Push everything to the top
        gbc.gridx = 2; gbc.gridy = 0; gbc.weighty = 1.0;
        calcPanel.add(Box.createVerticalGlue(), gbc);
        
        return calcPanel;
    }
    
    // --- Set Constants Panel (Tab 2) Methods ---

    private JPanel setConstantsPanel() {
        JPanel stConstPanel = new JPanel(new GridBagLayout());
        stConstPanel.setBorder(BorderFactory.createTitledBorder("Constant cost"));
        
        GridBagConstraints gbc = new GridBagConstraints();
        gbc.insets = new Insets(10, 10, 10, 10);
        gbc.anchor = GridBagConstraints.WEST;
        gbc.fill = GridBagConstraints.HORIZONTAL;

        JLabel titleLabel = new JLabel("materials costs");
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 24));
        gbc.gridx = 0; gbc.gridy = 0; gbc.gridwidth = 3; 
        stConstPanel.add(titleLabel, gbc);
        
        gbc.gridy = 1; gbc.insets = new Insets(0, 0, 20, 0);
        stConstPanel.add(new JSeparator(), gbc);
        
        // --- Input Fields ---
        // gbc.gridwidth = 1; 
        // gbc.insets = new Insets(10, 10, 10, 10);
        
        // gbc.gridx = 0; gbc.gridy = 2; 
        // stConstPanel.add(new JLabel("Total Pages:"), gbc);
        // quickTotalPagesField = new JTextField(10);
        // gbc.gridx = 1; gbc.weightx = 1.0;
        // stConstPanel.add(quickTotalPagesField, gbc);

        // gbc.gridx = 0; gbc.gridy = 3; 
        // stConstPanel.add(new JLabel("Color Pages:"), gbc);
        // quickColorPagesField = new JTextField(10);
        // gbc.gridx = 1; gbc.weightx = 1.0;
        // stConstPanel.add(quickColorPagesField, gbc);

        // gbc.gridx = 0; gbc.gridy = 4; 
        // stConstPanel.add(new JLabel("Print Code:"), gbc);
        // quickPageSizeComboBox = new JComboBox<>(SIZE_OPTIONS);
        // quickPageSizeComboBox.setSelectedItem(SIZE_OPTIONS[0]);
        // gbc.gridx = 1; gbc.weightx = 1.0;
        // stConstPanel.add(quickPageSizeComboBox, gbc);
        
        // // --- Calculate Button ---
        // JButton calculateButton = new JButton("Calculate Unit Cost (Kshs.)");
        // calculateButton.setBackground(new Color(60, 140, 200));
        // calculateButton.setForeground(Color.WHITE);
        // calculateButton.setFont(new Font("SansSerif", Font.BOLD, 16));
        // calculateButton.setFocusPainted(false);
        // calculateButton.addActionListener(e -> calculateQuickCost());
        
        // gbc.gridx = 0; gbc.gridy = 5; gbc.gridwidth = 2; gbc.insets = new Insets(20, 10, 20, 10);
        // stConstPanel.add(calculateButton, gbc);

        // // --- Result Label ---
        // JLabel resultTitle = new JLabel("ESTIMATED UNIT COST:");
        // resultTitle.setFont(new Font("SansSerif", Font.BOLD, 18));
        // gbc.gridx = 0; gbc.gridy = 6; gbc.gridwidth = 1; gbc.anchor = GridBagConstraints.EAST;
        // stConstPanel.add(resultTitle, gbc);

        // quickCostResultLabel = new JLabel("Kshs. 0.00");
        // quickCostResultLabel.setFont(new Font("SansSerif", Font.BOLD, 24));
        // quickCostResultLabel.setForeground(new Color(40, 170, 70));
        // gbc.gridx = 1; gbc.gridy = 6; gbc.anchor = GridBagConstraints.WEST;
        // stConstPanel.add(quickCostResultLabel, gbc);

        // // Push everything to the top
        // gbc.gridx = 2; gbc.gridy = 0; gbc.weighty = 1.0;
        // stConstPanel.add(Box.createVerticalGlue(), gbc);
        
        return stConstPanel;
    }

    /**
     * Calculates the cost based on inputs in the Quick Calculator tab and updates the result label.
     */
    private void calculateQuickCost() {
        String totalPagesText = quickTotalPagesField.getText().trim();
        String colorPagesText = quickColorPagesField.getText().trim();
        String pageSizeCode = (String) quickPageSizeComboBox.getSelectedItem();

        if (totalPagesText.isEmpty() || colorPagesText.isEmpty()) {
            quickCostResultLabel.setText("Kshs. N/A (Enter values)");
            return;
        }
        
        try {
            int totalPages = Integer.parseInt(totalPagesText);
            int colorPages = Integer.parseInt(colorPagesText);

            if (totalPages <= 0 || colorPages < 0 || colorPages > totalPages) {
                quickCostResultLabel.setText("Kshs. N/A (Invalid page count)");
                return;
            }
            
            double costPerBook = CostCalculator.calculateCost(totalPages, colorPages, pageSizeCode);
            quickCostResultLabel.setText(String.format("Kshs. %,.2f", costPerBook));
            
        } catch (NumberFormatException e) {
            quickCostResultLabel.setText("Kshs. N/A (Invalid number format)");
        } catch (IllegalArgumentException e) {
             quickCostResultLabel.setText("Kshs. N/A (Calculation Error)");
        }
    }

    // --- Control Panel Methods ---
    
    private JPanel createControlPanel() {
        JPanel controlPanel = new JPanel(new FlowLayout(FlowLayout.CENTER, 15, 10));
        
        JButton loadButton = new JButton("Refresh Catalogue");
        JButton deleteButton = new JButton("Delete Selected Book");
        JButton quoteBuilderButton = new JButton("Open Quote Builder (Shopping Cart)");
        JButton sendCatalogueButton = new JButton("Send Full Catalogue");
        
        // Button Styling 
        Font buttonFont = new Font("SansSerif", Font.BOLD, 14);
        
        loadButton.setBackground(new Color(60, 140, 200)); loadButton.setForeground(Color.BLACK);
        quoteBuilderButton.setBackground(new Color(40, 170, 70)); quoteBuilderButton.setForeground(Color.BLACK);
        sendCatalogueButton.setBackground(new Color(100, 80, 200)); sendCatalogueButton.setForeground(Color.BLACK); 
        deleteButton.setBackground(new Color(220, 50, 50)); deleteButton.setForeground(Color.BLACK);
        
        loadButton.setFont(buttonFont); quoteBuilderButton.setFont(buttonFont); 
        sendCatalogueButton.setFont(buttonFont); deleteButton.setFont(buttonFont);
        
        loadButton.addActionListener(e -> loadCatalogueData());
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
     * Gathers selected books and opens the QuoteBuilderDialog.
     */
    private void openQuoteBuilder() {
        int[] selectedRows = catalogueTable.getSelectedRows();
        
        List<QuoteItem> quoteItems = new ArrayList<>();
        
        for (int index : selectedRows) {
            int modelIndex = catalogueTable.convertRowIndexToModel(index); 
            if (modelIndex >= 0 && modelIndex < catalogue.size()) {
                 Book selectedBook = catalogue.get(modelIndex);
                 // Initialize with quantity 1
                 quoteItems.add(new QuoteItem(selectedBook, 1)); 
            }
        }

        // --- FIX: Pass the master catalogue (List<Book>) as the third argument (6 total arguments) ---
        catalogueTable.clearSelection();

        // Instantiate and open the separate QuoteBuilderDialog class
        QuoteBuilderDialog dialog = new QuoteBuilderDialog(
            this, 
            quoteItems, 
            this.catalogue, // The master list of all available books (FIX for 6 arguments)
            MINIMUM_COST, 
            TILL_NUMBER, 
            DEFAULT_SENDER_PHONE
        );
        dialog.setVisible(true);
    }
    
    /**
     * Prompts for client name and initiates the sending of the entire catalogue list.
     */
    private void sendFullCatalogue() {
        if (catalogue.isEmpty()) {
            JOptionPane.showMessageDialog(this, "The catalogue is currently empty.", "Catalogue Empty", JOptionPane.WARNING_MESSAGE);
            return;
        }

        String name = JOptionPane.showInputDialog(this, "Please enter the client's name:", "Client Name", JOptionPane.QUESTION_MESSAGE);
        if (name == null || name.trim().isEmpty()) {
            return; 
        }

        List<QuoteItem> fullCatalogueItems = new ArrayList<>();
        for (Book book : catalogue) {
            // Use 1 as a dummy quantity
            fullCatalogueItems.add(new QuoteItem(book, 1)); 
        }
        
        createAndSendFullCatalogueMessage(fullCatalogueItems, name, DEFAULT_SENDER_PHONE);
    }
    
    /**
     * Generates and sends a message listing the entire catalogue with unit prices via WhatsApp.
     */
    private void createAndSendFullCatalogueMessage(List<QuoteItem> quoteItems, String clientName, String clientPhone) {
        if (quoteItems.isEmpty()) {
             JOptionPane.showMessageDialog(this, "The catalogue list is empty.", "Catalogue Empty", JOptionPane.INFORMATION_MESSAGE);
             return;
        }
        
        StringBuilder messageBuilder = new StringBuilder();
        messageBuilder.append(String.format("Hello %s,\n\nHere is the full list of our available books and unit costs:\n\n", clientName));

        int count = 1;
        for (QuoteItem item : quoteItems) {
            Book book = item.getBook();
            String unitCostFormatted = DECIMAL_FORMAT.format(book.getCostPerBook()); 
            
            messageBuilder.append(String.format("*(%d).* *\"%s\"* \n- Unit Cost: *Kshs. %s*\n- Pages: %d (%d Color)\n- Size: Code %s\n\n", 
                count++, 
                book.getBookName().replace("\"", ""), 
                unitCostFormatted,
                book.getTotalPages(),
                book.getColorPages(),
                book.getPageSize()));
        }

        messageBuilder.append("For a custom quote, delivery, or further details, please contact us.\n");
        messageBuilder.append("- *Till No: " + TILL_NUMBER + "*");

        String message = messageBuilder.toString();
        String encodedMessage = URLEncoder.encode(message, StandardCharsets.UTF_8);

        String whatsappUrl = String.format("https://wa.me/%s?text=%s", clientPhone.replace("+", ""), encodedMessage);
        
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(whatsappUrl));
            } else {
                JOptionPane.showMessageDialog(this, 
                    "Desktop interaction is not fully supported. Catalogue message:\n\n" + message, 
                    "System Error", JOptionPane.ERROR_MESSAGE);
            }
        } catch (Exception e) {
            JOptionPane.showMessageDialog(this, 
                "Could not open WhatsApp link in browser. Error: " + e.getMessage(), 
                "Communication Error", JOptionPane.ERROR_MESSAGE);
        }
    }
    
    /**
     * Generates and sends the final quote message (called by QuoteBuilderDialog).
     */
    public void createAndSendQuoteMessage(List<QuoteItem> quoteItems, double discount, double finalTotal, String clientName, String clientPhone) {
        StringBuilder messageBuilder = new StringBuilder();
        messageBuilder.append(String.format("Hello %s, Thank you for your enquiry,\nFind the below quote:\n\n", clientName));

        double subtotal = 0.0;
        int count = 1;
        
        for (QuoteItem item : quoteItems) {
            double lineTotal = item.getLineTotal();
            subtotal += lineTotal;
            
            String unitCostFormatted = DECIMAL_FORMAT.format(item.getBook().getCostPerBook()); 
            String lineTotalFormatted = DECIMAL_FORMAT.format(lineTotal); 
            String copiesText = (item.getQuantity() == 1) ? "copy" : "copies";
            
            messageBuilder.append(String.format("*(%d).* %d %s of *\"%s\"* \nCosts per book: Kshs. %s\nTotal: Kshs. %s\n\n", 
                count++, 
                item.getQuantity(),
                copiesText,
                item.getBook().getBookName().replace("\"", ""), 
                unitCostFormatted,
                lineTotalFormatted));
        }

        // Round subtotal to the nearest 5
        double roundedSubtotal = Math.ceil(subtotal / 5.0) * 5.0;
        
        String discountFormatted = DECIMAL_FORMAT.format(discount);
        String subtotalFormatted = DECIMAL_FORMAT.format(roundedSubtotal);
        String totalInvoiceFormatted = DECIMAL_FORMAT.format(finalTotal);

        messageBuilder.append("\n"); 
        messageBuilder.append(String.format("Subtotal: Kshs. %s\n", subtotalFormatted));
        messageBuilder.append(String.format("Discount: Kshs. %s\n", discountFormatted));
        
        if (finalTotal == MINIMUM_COST && roundedSubtotal - discount < MINIMUM_COST) {
             messageBuilder.append(String.format("*(Note: Minimum order cost of Kshs. %,.0f applied)*\n", MINIMUM_COST));
        }
        
        messageBuilder.append(String.format("*TOTAL INVOICE*: *Kshs. %s*\n\n", totalInvoiceFormatted));
        
        messageBuilder.append("NOTE:\n");
        messageBuilder.append("- PRODUCTION BEGINS AFTER RECEIPT OF PAYMENT\n");
        messageBuilder.append("- DELIVERY WITHIN 2 WORKING DAYS\n\n");
        messageBuilder.append("- *Till No: " + TILL_NUMBER + "*");

        String message = messageBuilder.toString();
        String encodedMessage = URLEncoder.encode(message, StandardCharsets.UTF_8);

        String whatsappUrl = String.format("https://wa.me/%s?text=%s", clientPhone.replace("+", ""), encodedMessage);
        
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(whatsappUrl));
            } else {
                JOptionPane.showMessageDialog(this, "Desktop interaction is not fully supported. Quote message:\n\n" + message, "System Error", JOptionPane.ERROR_MESSAGE);
            }
        } catch (Exception e) {
            JOptionPane.showMessageDialog(this, "Could not open WhatsApp link. Error: " + e.getMessage(), "Communication Error", JOptionPane.ERROR_MESSAGE);
        }
    }

    // --- Main Method ---
    public static void main(String[] args) {
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception e) {
            // Use default Swing L&F
        }
        
        SwingUtilities.invokeLater(() -> new CatalogueManager());
    }
}